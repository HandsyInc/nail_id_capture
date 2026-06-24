"""
nail-measure-service  –  Phase 1 local proof
=============================================
FastAPI service that owns the 2A.1 absolute-width pipeline:

    image  →  [SAM2 segmentation]  →  contour_px
           →  homography (H)       →  contour_mm
           →  Shapely MRR          →  (width_raw, length_raw, angle)
           →  depth correction     →  width_mm_final

Phase 1 note
------------
SAM2 is not loaded in this local proof.  Pass ``contour_px`` in the
request body to bypass segmentation and exercise the full math pipeline
(H → MRR → depth).  This is how the Phase 1 tests work.

Phase 2: remove the contour_px override; wire in the real SAM2 call.
"""
from __future__ import annotations

import json
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
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
