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
) -> dict:
    """
    Full measurement pipeline from pixel contour.

    Steps:
        1. contour_px  → mm DataFrame  (via H)
        2. mm DataFrame → Shapely MRR  (width, length, angle)
        3. MRR width    → depth correction
    """
    df = contour_px_to_mm(contour_px, H)
    length_raw, width_raw, angle_deg, corners = calculate_width_from_mrr(df, use_mm=True)
    width_final = depth_correct(width_raw, h_mm, D_mm)
    length_final = depth_correct(length_raw, h_mm, D_mm)

    return {
        "width_mm": round(width_final, 4),
        "mrr_width_raw_mm": round(width_raw, 4),
        "mrr_length_mm": round(length_final, 4),
        "mrr_angle_deg": round(angle_deg, 4),
        "h_used_mm": h_mm,
        "D_used_mm": D_mm,
        "contour_px": contour_px,
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
