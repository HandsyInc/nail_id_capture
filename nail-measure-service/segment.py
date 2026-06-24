"""
Segmentation interface for nail-measure-service.

Phase 1 (no SAM2): returns a SAM2_UNAVAILABLE status so callers can
fall back to a pre-supplied contour_px override.

Phase 2 integration: replace the try/except below with the real
SAM2 predict_segment call (identical interface to phase_3/api/routers/segmentor.py).
"""
from __future__ import annotations

from typing import List, Optional, Tuple
import numpy as np

# Try to import SAM2 (not available in Phase 1 local proof)
try:
    from handsy_sam2 import predict_segment, create_mask_overlay  # Docker image
    _SAM2_AVAILABLE = True
except ImportError:
    try:
        from sam2 import predict_segment, create_mask_overlay  # local dev
        _SAM2_AVAILABLE = True
    except ImportError:
        _SAM2_AVAILABLE = False


def segment_nail(
    image_bytes: bytes,
    positive_points: List[Tuple[float, float]],
    negative_points: Optional[List[Tuple[float, float]]] = None,
) -> Tuple[bool, List[List[float]], str]:
    """
    Segment a nail from image bytes using SAM2.

    Args:
        image_bytes:      Raw JPEG/PNG image bytes
        positive_points:  [(x, y), ...] prompts over the nail plate
        negative_points:  [(x, y), ...] exclusion prompts (optional)

    Returns:
        (success, contour_px, message)
        contour_px: [[x, y], ...] pixel coordinates of the nail contour
                    Empty list if segmentation failed or SAM2 unavailable.
        message:    Human-readable status string.
    """
    if not _SAM2_AVAILABLE:
        return (
            False,
            [],
            "SAM2_UNAVAILABLE: segmentation model not loaded. "
            "Provide contour_px in the request to bypass segmentation (Phase 1 mode).",
        )

    import io
    from PIL import Image, ImageOps

    pil_image = Image.open(io.BytesIO(image_bytes))
    pil_image = ImageOps.exif_transpose(pil_image).convert("RGB")

    negative_points = negative_points or []
    all_points = positive_points + negative_points
    labels = np.array(
        [1] * len(positive_points) + [0] * len(negative_points), dtype=int
    )

    try:
        masks, _ = predict_segment(pil_image, np.array(all_points), labels)
        _, contours_raw = create_mask_overlay(pil_image, masks[0])
    except Exception as exc:
        return False, [], f"SAM2_ERROR: {exc}"

    if not contours_raw:
        return False, [], "SAM2_NO_CONTOUR: segmentation returned no contour."

    # Use the largest contour (same logic as phase_3/segmentor.py)
    largest = max(contours_raw, key=lambda c: len(c))
    contour_px = [[float(pt[0][0]), float(pt[0][1])] for pt in largest]
    return True, contour_px, "ok"
