"""
Core measurement logic: pixel → mm → Shapely MRR → depth correction.
Lifted directly from uw-handsy/phase_3/calculation/width_calculator.py
and phase_3/api/routers/measurements.py so the math path is identical to V1.
"""
from __future__ import annotations

import math
from typing import Tuple, List

import numpy as np
import pandas as pd
from shapely.geometry import Polygon


# ── Homography ────────────────────────────────────────────────────────────────

def px_to_mm_point(pt_px: Tuple[float, float], H: np.ndarray) -> Tuple[float, float]:
    """Convert a single pixel coordinate to mm using a 3×3 homography matrix."""
    x, y = pt_px
    v = np.array([x, y, 1.0], dtype=np.float64)
    X = H @ v
    return float(X[0] / X[2]), float(X[1] / X[2])


def contour_px_to_mm(contour_px: List[List[float]], H: np.ndarray) -> pd.DataFrame:
    """
    Convert a list of pixel contour points to a DataFrame with x_mm/y_mm columns.

    Args:
        contour_px: [[x0,y0], [x1,y1], ...] in image pixels
        H: 3×3 homography matrix (image pixels → card-plane mm)

    Returns:
        DataFrame with columns ['x', 'y', 'x_mm', 'y_mm']
    """
    df = pd.DataFrame(contour_px, columns=["x", "y"])
    def _convert(row):
        xm, ym = px_to_mm_point((row["x"], row["y"]), H)
        return pd.Series({"x_mm": xm, "y_mm": ym})
    df[["x_mm", "y_mm"]] = df.apply(_convert, axis=1)
    return df


# ── Shapely MRR (identical to V1 / phase_3) ──────────────────────────────────

def calculate_width_from_mrr(
    df: pd.DataFrame,
    use_mm: bool = True,
) -> Tuple[float, float, float, np.ndarray]:
    """
    Minimum Rotated Rectangle width/length from a contour DataFrame.

    Args:
        df: DataFrame with 'x_mm'/'y_mm' columns (use_mm=True) or 'x'/'y' (use_mm=False)
        use_mm: Whether to use mm columns (True) or pixel columns (False)

    Returns:
        (length_mm, width_mm, angle_deg, corners_4x2)
        length_mm: longer side of MRR
        width_mm:  shorter side of MRR  ← the nail plate width before depth correction
        angle_deg: angle of long edge relative to +x axis
        corners:   (4,2) array of rectangle corners
    """
    if use_mm:
        pts = df[["x_mm", "y_mm"]].to_numpy()
    else:
        pts = df[["x", "y"]].to_numpy()

    poly = Polygon(pts)
    mrr = poly.minimum_rotated_rectangle

    xs, ys = mrr.exterior.coords.xy
    corners = np.column_stack([xs, ys])[:4]

    # Stable corner ordering (sort by angle from centroid)
    c = corners.mean(axis=0)
    angles = np.arctan2(corners[:, 1] - c[1], corners[:, 0] - c[0])
    corners = corners[np.argsort(angles)]

    edge_vecs = np.roll(corners, -1, axis=0) - corners
    edge_lengths = np.linalg.norm(edge_vecs, axis=1)

    L_idx = int(np.argmax(edge_lengths))
    W_idx = (L_idx + 1) % 4
    length_mm = float(edge_lengths[L_idx])
    width_mm = float(edge_lengths[W_idx])

    dx, dy = edge_vecs[L_idx]
    angle_deg = math.degrees(math.atan2(dy, dx))

    return length_mm, width_mm, angle_deg, corners


# ── Local scale ───────────────────────────────────────────────────────────────

def scale_mm_per_px_at_point(H: np.ndarray, x_px: float, y_px: float) -> float:
    """
    Local isotropic scale (mm/px) of the homography at the given image pixel.

    Uses the 2×2 Jacobian of H : (x_px, y_px) → (X_mm, Y_mm) evaluated at
    the given point.  The square root of the absolute Jacobian determinant
    gives the area-preserving scale factor in mm/px.

    For a well-calibrated card homography this closely matches the value
    returned by pixelsPerMmAt() in card-homography.ts (the TypeScript
    Jacobian implementation).  Agreement confirms H is consistent between
    the Python service and the Next.js bridge.
    """
    v = np.array([x_px, y_px, 1.0], dtype=np.float64)
    w    = H[2] @ v                   # denominator
    Xw   = float(H[0] @ v)            # H[0]·v  (= X * w)
    Yw   = float(H[1] @ v)            # H[1]·v  (= Y * w)

    # Quotient-rule partials: d/dx (X/w) = (h00*w - Xw*h20) / w²  etc.
    dXdx = (H[0, 0] * w - Xw * H[2, 0]) / (w * w)
    dXdy = (H[0, 1] * w - Xw * H[2, 1]) / (w * w)
    dYdx = (H[1, 0] * w - Yw * H[2, 0]) / (w * w)
    dYdy = (H[1, 1] * w - Yw * H[2, 1]) / (w * w)

    J = np.array([[dXdx, dXdy], [dYdx, dYdy]], dtype=np.float64)
    return float(math.sqrt(abs(np.linalg.det(J))))


# ── Depth correction ──────────────────────────────────────────────────────────

def depth_correct(width_mm_raw: float, h_mm: float, D_mm: float) -> float:
    """
    Apply depth correction:
        width_mm_final = width_mm_raw × (D - h) / D

    Args:
        width_mm_raw: MRR width in card-plane mm
        h_mm:  card-to-nail distance (hand thickness above card)
        D_mm:  camera-to-card distance

    Returns:
        Depth-corrected width in mm
    """
    scaling_factor = (D_mm - h_mm) / D_mm
    return width_mm_raw * scaling_factor


# ── Combined pipeline ─────────────────────────────────────────────────────────

def measure_from_contour_px(
    contour_px: List[List[float]],
    H: np.ndarray,
    h_mm: float,
    D_mm: float,
    nail_x: float | None = None,
    nail_y: float | None = None,
) -> dict:
    """
    Full measurement pipeline from pixel contour.

    Steps:
        1. contour_px  → MRR in pixel space          (diagnostic only)
        2. contour_px  → mm DataFrame  (via H)
        3. mm DataFrame → Shapely MRR  (width, length, angle, corners_mm)
        4. MRR width    → depth correction
        5. Optional: local scale at nail click

    Returns dict with all intermediate values for D4.8 diagnostics.
    """
    # ── Step 1: pixel-space MRR (before H transform) ─────────────────────────
    df_px = pd.DataFrame(contour_px, columns=["x", "y"])
    length_px, width_px, _, corners_px = calculate_width_from_mrr(df_px, use_mm=False)

    # ── Step 2–3: mm-space MRR (after H transform) ────────────────────────────
    df = contour_px_to_mm(contour_px, H)
    length_raw, width_raw, angle_deg, corners_mm = calculate_width_from_mrr(df, use_mm=True)

    # ── Step 4: depth correction ──────────────────────────────────────────────
    width_final  = depth_correct(width_raw, h_mm, D_mm)
    length_final = depth_correct(length_raw, h_mm, D_mm)

    # ── Step 5: local scale at nail click ─────────────────────────────────────
    scale_mm_per_px: float | None = None
    if nail_x is not None and nail_y is not None:
        scale_mm_per_px = scale_mm_per_px_at_point(H, nail_x, nail_y)

    # ── D4.8.6 diagnostics ────────────────────────────────────────────────────

    # 1. Explicit depth correction multiplier
    depth_correction_factor = (D_mm - h_mm) / D_mm

    # 2. Width sweep: what width_mm would be at canonical h values (D fixed)
    width_mm_sweep = {
        h_val: round(depth_correct(width_raw, float(h_val), D_mm), 4)
        for h_val in (18, 20, 22, 25)
    }

    # 3. Contour bounding box in pixels [xmin, ymin, xmax, ymax]
    xs_px = [p[0] for p in contour_px]
    ys_px = [p[1] for p in contour_px]
    contour_bbox_px = [min(xs_px), min(ys_px), max(xs_px), max(ys_px)]

    # 4. Naive mm estimate: pixel MRR short axis × local scale (no H→MRR path).
    #    If naive < mrr_width_raw_mm the MRR-in-mm-space is inflating the result.
    mrr_width_naive_mm: float | None = None
    if scale_mm_per_px is not None:
        mrr_width_naive_mm = round(width_px * scale_mm_per_px, 4)

    return {
        # Final result
        "width_mm":            round(width_final,  4),
        # Pre-depth H-transformed width
        "mrr_width_raw_mm":    round(width_raw,    4),
        "mrr_length_mm":       round(length_final, 4),
        "mrr_angle_deg":       round(angle_deg,    4),
        # Pixel-space diagnostics
        "mrr_width_px":        round(width_px,     2),
        "mrr_length_px":       round(length_px,    2),
        # Scale diagnostics
        "scale_mm_per_px_at_click": round(scale_mm_per_px, 6) if scale_mm_per_px is not None else None,
        # Parameters used
        "h_used_mm":           h_mm,
        "D_used_mm":           D_mm,
        # Geometry (for overlay generation)
        "contour_px":          contour_px,
        "mrr_corners_mm":      corners_mm.tolist(),
        "mrr_corners_px":      corners_px.tolist(),
        # ── D4.8.6 diagnostic fields ──────────────────────────────────────────
        "depth_correction_factor": round(depth_correction_factor, 6),
        "width_mm_sweep":          width_mm_sweep,      # {18: mm, 20: mm, 22: mm, 25: mm}
        "contour_bbox_px":         contour_bbox_px,     # [xmin, ymin, xmax, ymax]
        "mrr_width_naive_mm":      mrr_width_naive_mm,  # px MRR × local scale (bypasses H→MRR)
    }


def measure_from_mm_df(
    df: pd.DataFrame,
    h_mm: float,
    D_mm: float,
) -> dict:
    """
    Measurement pipeline from a DataFrame that already has x_mm/y_mm columns.
    Used when the caller has pre-computed mm coordinates (e.g., from a V1 CSV fixture).
    """
    length_raw, width_raw, angle_deg, corners = calculate_width_from_mrr(df, use_mm=True)
    width_final = depth_correct(width_raw, h_mm, D_mm)
    length_final = depth_correct(length_raw, h_mm, D_mm)

    contour_px = (
        df[["x", "y"]].values.tolist()
        if "x" in df.columns and "y" in df.columns
        else []
    )

    return {
        "width_mm": round(width_final, 4),
        "mrr_width_raw_mm": round(width_raw, 4),
        "mrr_length_mm": round(length_final, 4),
        "mrr_angle_deg": round(angle_deg, 4),
        "h_used_mm": h_mm,
        "D_used_mm": D_mm,
        "contour_px": contour_px,
    }
