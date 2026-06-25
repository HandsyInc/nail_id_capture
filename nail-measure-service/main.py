"""
nail-measure-service  –  Phase 1 local proof
=============================================
FastAPI service that owns the 2A.1 absolute-width pipeline:

    image  →  [SAM2 segmentation]  →  contour_px
           →  homography (H)       →  contour_mm
           →  Shapely MRR          →  (width_raw, length_raw, angle)
           →  depth correction     →  width_mm_final

Endpoints
---------
POST /measure           — Phase 1 / Phase 2 combined (original)
POST /api/v1/chord_width — D4.7 founder-assisted flow; full diagnostic output
GET  /health

D4.8 diagnostics (in /api/v1/chord_width response)
---------------------------------------------------
  mrr_width_px          — MRR short side in raw image pixels (before H)
  mrr_length_px         — MRR long  side in raw image pixels
  mrr_width_raw_mm      — MRR short side in card-plane mm  (after H, before depth)
  width_mm              — final depth-corrected width
  scale_mm_per_px_at_click — local mm/px scale at the nail click point
"""
from __future__ import annotations

import base64
import io
import json
from typing import List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, ImageOps
from pydantic import BaseModel

from measure import measure_from_contour_px
from segment import segment_nail

app = FastAPI(
    title="nail-measure-service",
    description="2A.1 absolute width: segmentation + homography + Shapely MRR + depth correction",
    version="0.1.0",
)


# ── Response schema ───────────────────────────────────────────────────────────

class MeasureResponse(BaseModel):
    width_mm: Optional[float]
    mrr_width_raw_mm: Optional[float]
    mrr_length_mm: Optional[float]
    mrr_angle_deg: Optional[float]
    h_used_mm: float
    D_used_mm: float
    contour_px: List[List[float]]
    status: str
    message: str


# ── Endpoint ──────────────────────────────────────────────────────────────────

@app.post("/measure", response_model=MeasureResponse)
async def measure(
    image: UploadFile = File(..., description="Top-down nail capture (JPEG or PNG)"),
    H_matrix: str = Form(
        ...,
        description="3×3 homography matrix as a JSON-encoded nested list: "
                    "[[h00,h01,h02],[h10,h11,h12],[h20,h21,h22]]",
    ),
    h_mm: float = Form(25.0, description="Card-to-nail distance assumption (mm)"),
    D_mm: float = Form(269.0, description="Camera-to-card distance (mm)"),
    positive_points: str = Form(
        "[]",
        description="SAM2 prompt points as JSON list of [x,y] pairs over the nail plate",
    ),
    contour_px: Optional[str] = Form(
        None,
        description=(
            "Phase 1 override: pre-computed contour as JSON list of [x,y] pairs. "
            "When provided, SAM2 segmentation is skipped entirely."
        ),
    ),
) -> MeasureResponse:
    """
    Measure absolute nail width from a top-down capture.

    Full pipeline (Phase 2):
        image + positive_points → SAM2 → contour_px → H → MRR → depth → width_mm

    Phase 1 bypass (contour_px provided):
        contour_px → H → MRR → depth → width_mm
    """
    # Parse H matrix
    try:
        H = np.array(json.loads(H_matrix), dtype=np.float64)
        if H.shape != (3, 3):
            raise ValueError(f"H_matrix must be 3×3, got {H.shape}")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid H_matrix: {exc}")

    # Determine contour source
    if contour_px is not None:
        # Phase 1 path: caller supplied the contour
        try:
            contour = json.loads(contour_px)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Invalid contour_px JSON: {exc}")
        seg_message = "contour_px_override"
    else:
        # Phase 2 path: run SAM2
        try:
            pts = json.loads(positive_points)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Invalid positive_points JSON: {exc}")

        image_bytes = await image.read()
        success, contour, seg_message = segment_nail(image_bytes, pts)

        if not success:
            return MeasureResponse(
                width_mm=None,
                mrr_width_raw_mm=None,
                mrr_length_mm=None,
                mrr_angle_deg=None,
                h_used_mm=h_mm,
                D_used_mm=D_mm,
                contour_px=[],
                status="segmentation_failed",
                message=seg_message,
            )

    # Math pipeline: px → mm → MRR → depth
    try:
        result = measure_from_contour_px(contour, H, h_mm, D_mm)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Measurement error: {exc}")

    return MeasureResponse(
        **result,
        status="ok",
        message=seg_message,
    )


@app.get("/health")
def health():
    return {"status": "ok", "service": "nail-measure-service", "version": "0.1.0"}


# ── Overlay helper ────────────────────────────────────────────────────────────

def _generate_overlay(
    image_bytes: bytes,
    contour_px: list,
    mrr_corners_px: list,
    nail_x: float,
    nail_y: float,
) -> str:
    """
    Draw SAM2 contour + MRR rectangle + nail click on the image.
    Returns a base64-encoded JPEG string.
    """
    pil_img = Image.open(io.BytesIO(image_bytes))
    pil_img = ImageOps.exif_transpose(pil_img).convert("RGB")
    arr = np.array(pil_img, dtype=np.uint8)

    # Convert to BGR for OpenCV
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

    # Semi-transparent green fill over the nail mask
    contour_arr = np.array(contour_px, dtype=np.int32).reshape(-1, 1, 2)
    mask = np.zeros(bgr.shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [contour_arr], 255)
    green_layer = bgr.copy()
    green_layer[mask > 0] = [52, 211, 153]   # green tint (BGR)
    bgr = cv2.addWeighted(bgr, 0.65, green_layer, 0.35, 0)

    # Contour outline
    cv2.polylines(bgr, [contour_arr], isClosed=True, color=(52, 211, 153), thickness=2)

    # MRR rectangle (orange)
    if mrr_corners_px and len(mrr_corners_px) == 4:
        corners_int = np.array(mrr_corners_px, dtype=np.int32).reshape(-1, 1, 2)
        cv2.polylines(bgr, [corners_int], isClosed=True, color=(36, 191, 251), thickness=2)

    # Nail click dot (red with white ring)
    cx, cy = int(round(nail_x)), int(round(nail_y))
    cv2.circle(bgr, (cx, cy), 10, (255, 255, 255), 2)
    cv2.circle(bgr, (cx, cy),  6, (68,  68, 239), -1)

    # Encode back to JPEG
    rgb_out = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    out_pil = Image.fromarray(rgb_out)
    buf = io.BytesIO()
    out_pil.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _mm_corners_to_px(corners_mm: list, H: np.ndarray) -> list:
    """
    Convert MRR corner coordinates from card-plane mm back to image pixels
    using the inverse of H (imageToCard → cardToImage).
    """
    H_inv = np.linalg.inv(H)
    px_corners = []
    for xm, ym in corners_mm:
        v = np.array([xm, ym, 1.0], dtype=np.float64)
        p = H_inv @ v
        px_corners.append([float(p[0] / p[2]), float(p[1] / p[2])])
    return px_corners


# ── /api/v1/chord_width ───────────────────────────────────────────────────────

@app.post("/api/v1/chord_width")
async def chord_width(
    image: UploadFile = File(..., description="Top-down nail JPEG/PNG"),
    H_matrix: str = Form(
        ...,
        description="3×3 imageToCard homography as JSON nested list",
    ),
    nail_x: float = Form(..., description="Founder click x in natural image pixels"),
    nail_y: float = Form(..., description="Founder click y in natural image pixels"),
    h_mm:   float = Form(25.0,  description="Card-to-nail distance (mm)"),
    D_mm:   float = Form(269.0, description="Camera-to-card distance (mm)"),
):
    """
    D4.7 founder-assisted chord-width endpoint.

    Pipeline:
        image + nail click → SAM2 → contour_px → H → MRR → depth → width_mm

    Response includes full D4.8 diagnostic breakdown:
        mrr_width_px       — pixel-space MRR width (before any mm conversion)
        mrr_width_raw_mm   — card-plane mm width   (after H, before depth)
        width_mm           — final depth-corrected width
        scale_mm_per_px_at_click — local scale at the nail click
    """
    # Parse H
    try:
        H = np.array(json.loads(H_matrix), dtype=np.float64)
        if H.shape != (3, 3):
            raise ValueError(f"Expected 3×3, got {H.shape}")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid H_matrix: {exc}")

    # Segmentation
    image_bytes = await image.read()
    success, contour, seg_message = segment_nail(image_bytes, [(nail_x, nail_y)])

    if not success:
        raise HTTPException(
            status_code=422,
            detail=f"Segmentation failed: {seg_message}",
        )

    # Measurement pipeline (with diagnostics)
    try:
        result = measure_from_contour_px(
            contour_px=contour,
            H=H,
            h_mm=h_mm,
            D_mm=D_mm,
            nail_x=nail_x,
            nail_y=nail_y,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Measurement error: {exc}")

    # Convert MRR mm corners → px for overlay drawing
    mrr_corners_px = _mm_corners_to_px(result["mrr_corners_mm"], H)

    # Generate overlay image
    try:
        overlay_b64 = _generate_overlay(
            image_bytes=image_bytes,
            contour_px=contour,
            mrr_corners_px=mrr_corners_px,
            nail_x=nail_x,
            nail_y=nail_y,
        )
    except Exception as exc:
        # Overlay is diagnostic-only; don't fail the whole request
        overlay_b64 = ""

    return {
        # Core ChordResult fields (matches ChordCanvas.tsx ChordResult type)
        "width_mm":           result["width_mm"],
        "length_mm":          result["mrr_length_mm"],
        "angle_deg":          result["mrr_angle_deg"],
        "overlay_image_b64":  overlay_b64,
        "contour_px":         result["contour_px"],
        "mrr_corners_mm":     result["mrr_corners_mm"],
        "nail_click_used":    {"x": nail_x, "y": nail_y},
        # D4.8 diagnostic fields
        "mrr_width_px":                 result["mrr_width_px"],
        "mrr_length_px":                result["mrr_length_px"],
        "mrr_width_raw_mm":             result["mrr_width_raw_mm"],
        "scale_mm_per_px_at_click":     result["scale_mm_per_px_at_click"],
        "h_used_mm":                    result["h_used_mm"],
        "D_used_mm":                    result["D_used_mm"],
        "seg_message":                  seg_message,
    }
