"""
Offline card-detection probe.

Goal
----
Give us a fast real-world read on how reliably a classical-CV pipeline can find
a standard dark credit/debit/loyalty card in our existing pilot capture photos,
before we commit to the larger /capture-v2 live-overlay infrastructure.

This is intentionally minimal:
  * one script, runs locally in Python
  * loads each image from --input
  * runs the detection pipeline
  * writes an annotated copy to --output/annotated/ (green quadrilateral if
    detected; red label if not; yellow if detected but low confidence)
  * appends one row per image to --output/results.csv with empty columns for
    a human reviewer to fill in (card_color, card_finish, lighting, correct)

The CSV's machine-filled columns describe what the detector *thinks*. The
reviewer columns capture ground truth. The intersection is the reliability
number we need.

Pipeline (try in order; first plausible result wins)
----------------------------------------------------
  1. Otsu binarization. Dark card on lighter background pops out cleanly.
     Morphological close to fill in card-face text/chip cutouts/glare gaps.
     Find external contours, filter by area + aspect ratio near ISO/IEC 7810
     ID-1 (1.586:1, with generous tolerance for perspective).
     Approximate to polygon; keep if 4 vertices.
  2. Canny edge detection + Hough fallback. If Otsu produces no plausible
     quadrilateral, fall back to Canny + contour approximation on a
     blurred grayscale, with the same aspect-ratio gate.

Both branches feed into the same `Detection` record with a confidence score so
results are comparable across branches in the CSV.

Distance/tilt proxies recorded for every successful detection:
  * card_pixel_width:  long-edge length in image pixels
  * card_pixel_height: short-edge length in image pixels
  * frame_width_pct:   long edge / image short-side, as a percentage
  * observed_ratio:    long edge / short edge (truth is ~1.586)
  * ratio_deviation:   observed_ratio - 1.586 (tilt proxy)

These are not used to decide success — they are recorded so we can see, even
on the small pilot sample, whether they vary in the way we'd expect across
real captures.

This script does NOT decide success rate on its own. That requires the human
review pass on the `correct` column. The script's job is to make that review
as fast as possible.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import cv2
import numpy as np


# ISO/IEC 7810 ID-1 (standard credit card): 85.60mm x 53.98mm.
CARD_TRUE_RATIO = 85.60 / 53.98  # ~1.586

# Aspect-ratio tolerance is deliberately generous: a card seen from a tilted
# camera will distort toward a trapezoid, and the bounding ratio drifts. We'd
# rather over-accept here and let the human reviewer reject false positives
# than under-detect on tilted captures (which is exactly the case our final
# overlay needs to handle).
ASPECT_RATIO_TOLERANCE = 0.45  # accept ratios from ~1.14 to ~2.04

# A card on white paper that is roughly framed should occupy a meaningful
# fraction of the image. Anything smaller than this is almost certainly a
# false positive (logo, shadow, hand crease).
MIN_AREA_FRAC = 0.01  # 1% of image area
MAX_AREA_FRAC = 0.60  # 60% — anything larger is the whole page, not a card

# When the script downsamples for detection, this is the long-edge target.
# Pilot photos are 3024x4032; running contour detection at full res is slow
# and adds no accuracy for finding a ~25% card. 1200px long edge is plenty.
DETECT_LONG_EDGE = 1200

# --- Tuning gates added after the 125-photo bucketed analysis. ---
# These target the "dark background contamination" failure mode where the
# detector latches onto a desk edge / wood floor strip instead of the card.
#
# EDGE_MARGIN_FRAC: corners closer than this fraction of the image short
# side to any image edge cause rejection. A real card sitting on white paper
# essentially never extends to the image border in our pilot dataset
# (frame_width_pct on real hits ranged 19.9 - 98.8 but card corners were
# inset by at least a few percent of the frame); intruding desk/wood strips
# almost always touch the border. 1% is tight enough not to false-reject
# tight-framing legitimate cards.
# Calibrated empirically from the 125-photo run: the 3 wood-strip false
# positives had at least one corner at exactly 0.00% from the image edge,
# while the closest legitimate detection sat at 0.13%. 0.001 cleanly
# separates the two groups without burning safety margin on either side.
EDGE_MARGIN_FRAC = 0.001
# SURROUND_MIN_DELTA: the mean intensity of a ring just outside the
# candidate must exceed the candidate's mean intensity by at least this many
# 8-bit units. Cards on paper give ring deltas in the 60-150 range; wood
# strips surrounded by more wood give near-zero (sometimes negative) deltas.
# 20 is a conservative floor.
SURROUND_MIN_DELTA = 20
# SURROUND_RING_FRAC: the surrounding-ring band thickness, expressed as a
# fraction of the candidate's short edge. Small enough that the ring stays
# adjacent to the candidate; large enough that a few stray pixels don't
# swing the mean. Capped via SURROUND_RING_MAX_PX so the dilation kernel
# doesn't blow up on big candidates.
SURROUND_RING_FRAC = 0.08
SURROUND_RING_MAX_PX = 24


@dataclass
class Detection:
    """One detection result, ready to be CSV-serialized."""

    filename: str
    detected: bool
    method: str            # "otsu" | "canny" | "none"
    confidence: str        # "high" | "low" | ""
    image_width: int
    image_height: int
    card_pixel_width: float
    card_pixel_height: float
    frame_width_pct: float
    observed_ratio: float
    ratio_deviation: float
    corners: str           # JSON-ish "x1,y1;x2,y2;x3,y3;x4,y4" at full-res, or ""
    notes: str             # short machine-side note about why a branch fired/failed
    # Human-review columns — left blank for the reviewer to fill in.
    card_color: str = ""
    card_finish: str = ""
    lighting: str = ""
    correct: str = ""


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Return four corners in a stable [TL, TR, BR, BL] order."""
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).flatten()
    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = pts[np.argmin(s)]      # TL  — smallest x+y
    ordered[2] = pts[np.argmax(s)]      # BR  — largest x+y
    ordered[1] = pts[np.argmin(diff)]   # TR  — smallest y-x
    ordered[3] = pts[np.argmax(diff)]   # BL  — largest y-x
    return ordered


def _quad_edges(corners: np.ndarray) -> tuple[float, float]:
    """Return (long_edge, short_edge) lengths of an ordered quadrilateral."""
    tl, tr, br, bl = corners
    top    = np.linalg.norm(tr - tl)
    right  = np.linalg.norm(br - tr)
    bottom = np.linalg.norm(br - bl)
    left   = np.linalg.norm(bl - tl)
    horizontal = (top + bottom) / 2
    vertical   = (left + right) / 2
    long_edge  = max(horizontal, vertical)
    short_edge = min(horizontal, vertical)
    return long_edge, short_edge


def _passes_edge_margin(corners: np.ndarray, image_shape: tuple) -> bool:
    """
    Reject candidates whose corners come within EDGE_MARGIN_FRAC of any
    image edge. The wood/desk false positives we saw in the 125-photo run
    all had at least one corner pinned to the image border because the
    intruding dark strip was clipped by the frame.
    """
    h, w = image_shape[:2]
    margin = EDGE_MARGIN_FRAC * min(h, w)
    xs = corners[:, 0]
    ys = corners[:, 1]
    if xs.min() < margin or ys.min() < margin:
        return False
    if xs.max() > (w - margin) or ys.max() > (h - margin):
        return False
    return True


def _passes_lighter_surround(corners: np.ndarray, gray: np.ndarray) -> bool:
    """
    Require the ring of pixels just outside the candidate quadrilateral to
    be substantially lighter than the candidate's interior. This is the
    "card sits on paper, not on more wood" check.

    Implementation: build two binary masks — one filled inside the
    candidate, one of a dilated-minus-eroded ring around the candidate —
    and compare mean grayscale intensities.
    """
    h, w = gray.shape[:2]
    candidate_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(candidate_mask, [corners.astype(np.int32)], 255)

    _, short_edge = _quad_edges(corners)
    ring_thickness = max(3, min(SURROUND_RING_MAX_PX,
                                 int(short_edge * SURROUND_RING_FRAC)))
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (ring_thickness * 2 + 1, ring_thickness * 2 + 1)
    )
    dilated = cv2.dilate(candidate_mask, kernel)
    ring_mask = cv2.subtract(dilated, candidate_mask)

    if int(ring_mask.sum()) == 0 or int(candidate_mask.sum()) == 0:
        return False

    candidate_mean = float(cv2.mean(gray, mask=candidate_mask)[0])
    ring_mean = float(cv2.mean(gray, mask=ring_mask)[0])
    return (ring_mean - candidate_mean) >= SURROUND_MIN_DELTA


def _score_quadrilateral(corners: np.ndarray, image_area: float) -> Optional[dict]:
    """
    Return a dict of metrics if the quadrilateral passes aspect/area gates,
    otherwise None.
    """
    long_edge, short_edge = _quad_edges(corners)
    if short_edge <= 1:
        return None
    ratio = long_edge / short_edge
    if abs(ratio - CARD_TRUE_RATIO) > ASPECT_RATIO_TOLERANCE:
        return None
    area = cv2.contourArea(corners.astype(np.float32))
    area_frac = area / image_area
    if not (MIN_AREA_FRAC <= area_frac <= MAX_AREA_FRAC):
        return None
    return {
        "long_edge": long_edge,
        "short_edge": short_edge,
        "ratio": ratio,
        "area": area,
        "area_frac": area_frac,
    }


def _find_card_otsu(gray: np.ndarray) -> tuple[Optional[np.ndarray], str]:
    """
    Branch 1: Otsu binarization. Returns (ordered_corners, note) or (None, note).

    Tries both polarities of the threshold — dark card on light background,
    AND light card on dark background — so the same code path can verify the
    rare-but-possible inverse case.
    """
    image_area = float(gray.shape[0] * gray.shape[1])
    best: Optional[dict] = None
    best_corners: Optional[np.ndarray] = None
    best_note = "otsu: no candidate passed gates"

    for invert in (False, True):
        if invert:
            _, binarized = cv2.threshold(
                gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
            )
        else:
            _, binarized = cv2.threshold(
                gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
            )

        # Close gaps from text/chip/glare on the card face. Kernel size is
        # ~1% of the image's short side — scales with resolution.
        k = max(3, gray.shape[0] // 100)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        closed = cv2.morphologyEx(binarized, cv2.MORPH_CLOSE, kernel)

        contours, _ = cv2.findContours(
            closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        if not contours:
            continue

        for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:10]:
            perim = cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, 0.02 * perim, True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            corners = _order_corners(approx)
            scored = _score_quadrilateral(corners, image_area)
            if scored is None:
                continue
            # Context gates added in the tuning round. The iteration runs
            # candidates largest-first; if the biggest dark blob is desk/floor
            # it now gets rejected and the loop continues to the next-largest
            # contour, which is typically the actual card.
            if not _passes_edge_margin(corners, gray.shape):
                continue
            # Lighter-surround gate is implemented (see _passes_lighter_surround)
            # but disabled here. The 125-photo sensitivity test showed it
            # produced identical results to edge-margin alone on this dataset
            # — every flip vs the pre-tuning baseline was attributable to
            # edge-margin. Leaving the helper in place but inactive so a
            # future iteration can re-enable it without re-implementing if
            # we hit a failure mode where edge-margin isn't sufficient.
            if best is None or scored["area"] > best["area"]:
                best = scored
                best_corners = corners
                best_note = (
                    f"otsu: invert={invert} area_frac={scored['area_frac']:.3f} "
                    f"ratio={scored['ratio']:.3f}"
                )

    return best_corners, best_note


def _find_card_canny(gray: np.ndarray) -> tuple[Optional[np.ndarray], str]:
    """Branch 2: Canny edges. Fallback when Otsu finds nothing plausible."""
    image_area = float(gray.shape[0] * gray.shape[1])

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    # Edges with auto thresholds based on the image's median intensity.
    v = float(np.median(blurred))
    lower = int(max(0, 0.66 * v))
    upper = int(min(255, 1.33 * v))
    edges = cv2.Canny(blurred, lower, upper)
    # Dilate slightly so fragmented edges close into contours.
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(
        edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contours:
        return None, "canny: no contours"

    best: Optional[dict] = None
    best_corners: Optional[np.ndarray] = None
    for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:15]:
        perim = cv2.arcLength(cnt, True)
        # Slightly looser approximation tolerance than Otsu because edges
        # are noisier.
        approx = cv2.approxPolyDP(cnt, 0.03 * perim, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        corners = _order_corners(approx)
        scored = _score_quadrilateral(corners, image_area)
        if scored is None:
            continue
        # Same context gates as the Otsu branch.
        if not _passes_edge_margin(corners, gray.shape):
            continue
        if not _passes_lighter_surround(corners, gray):
            continue
        if best is None or scored["area"] > best["area"]:
            best = scored
            best_corners = corners
    if best is None:
        return None, "canny: no candidate passed gates"
    return best_corners, (
        f"canny: area_frac={best['area_frac']:.3f} ratio={best['ratio']:.3f}"
    )


def detect_card(image_bgr: np.ndarray) -> tuple[Optional[np.ndarray], str, str]:
    """
    Top-level detector. Returns (corners_at_full_res_or_None, method, note).
    """
    h, w = image_bgr.shape[:2]
    long_edge = max(h, w)
    scale = DETECT_LONG_EDGE / long_edge if long_edge > DETECT_LONG_EDGE else 1.0
    if scale < 1.0:
        new_w, new_h = int(w * scale), int(h * scale)
        small = cv2.resize(image_bgr, (new_w, new_h), interpolation=cv2.INTER_AREA)
    else:
        small = image_bgr

    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    corners, note = _find_card_otsu(gray)
    method = "otsu"
    if corners is None:
        corners_canny, note_canny = _find_card_canny(gray)
        if corners_canny is not None:
            corners = corners_canny
            method = "canny"
            note = note_canny
        else:
            note = f"{note} | {note_canny}"
            method = "none"

    if corners is None:
        return None, method, note

    # Rescale corners back to full-resolution coordinates.
    if scale != 1.0:
        corners = corners / scale
    return corners, method, note


def annotate(image_bgr: np.ndarray, corners: Optional[np.ndarray],
             detected: bool, confidence: str, method: str) -> np.ndarray:
    out = image_bgr.copy()
    h, w = out.shape[:2]
    if detected and corners is not None:
        color = (0, 220, 0) if confidence == "high" else (0, 220, 220)
        pts = corners.astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(out, [pts], isClosed=True, color=color, thickness=8)
        for (x, y) in corners.astype(np.int32):
            cv2.circle(out, (int(x), int(y)), 14, color, -1)
        label = f"{method.upper()} ({confidence})"
        cv2.rectangle(out, (0, 0), (w, 80), (0, 0, 0), -1)
        cv2.putText(out, label, (20, 55), cv2.FONT_HERSHEY_SIMPLEX,
                    1.6, color, 3, cv2.LINE_AA)
    else:
        cv2.rectangle(out, (0, 0), (w, 80), (0, 0, 200), -1)
        cv2.putText(out, "NO DETECTION", (20, 55),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 3, cv2.LINE_AA)
    return out


def confidence_from(metrics: dict) -> str:
    """A crude 'how clean was this' tag, just for prioritizing review."""
    ratio_dev = abs(metrics["ratio"] - CARD_TRUE_RATIO)
    if ratio_dev < 0.15 and metrics["area_frac"] >= 0.04:
        return "high"
    return "low"


def process_image(path: Path) -> tuple[Detection, np.ndarray]:
    image_bgr = cv2.imread(str(path))
    if image_bgr is None:
        # Pillow fallback in case OpenCV's JPEG decoder hiccups.
        from PIL import Image as PILImage
        pil = PILImage.open(path).convert("RGB")
        image_bgr = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    h, w = image_bgr.shape[:2]
    corners, method, note = detect_card(image_bgr)

    if corners is None:
        det = Detection(
            filename=path.name, detected=False, method=method, confidence="",
            image_width=w, image_height=h,
            card_pixel_width=0.0, card_pixel_height=0.0,
            frame_width_pct=0.0, observed_ratio=0.0, ratio_deviation=0.0,
            corners="", notes=note,
        )
        annotated = annotate(image_bgr, None, False, "", method)
        return det, annotated

    long_edge, short_edge = _quad_edges(corners)
    ratio = long_edge / short_edge if short_edge > 0 else 0.0
    image_short_side = min(w, h)
    frame_pct = (long_edge / image_short_side) * 100 if image_short_side else 0.0
    metrics = {
        "ratio": ratio,
        "area_frac": cv2.contourArea(corners.astype(np.float32)) / float(w * h),
    }
    conf = confidence_from(metrics)
    corners_str = ";".join(f"{int(x)},{int(y)}" for x, y in corners)
    det = Detection(
        filename=path.name, detected=True, method=method, confidence=conf,
        image_width=w, image_height=h,
        card_pixel_width=round(long_edge, 1),
        card_pixel_height=round(short_edge, 1),
        frame_width_pct=round(frame_pct, 2),
        observed_ratio=round(ratio, 3),
        ratio_deviation=round(ratio - CARD_TRUE_RATIO, 3),
        corners=corners_str, notes=note,
    )
    annotated = annotate(image_bgr, corners, True, conf, method)
    return det, annotated


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  required=True, help="folder of input JPEGs")
    parser.add_argument("--output", required=True, help="folder to write annotated images and results.csv")
    args = parser.parse_args()

    in_dir = Path(args.input).expanduser().resolve()
    out_dir = Path(args.output).expanduser().resolve()
    annotated_dir = out_dir / "annotated"
    annotated_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "results.csv"

    image_paths = sorted(
        p for p in in_dir.iterdir()
        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    if not image_paths:
        print(f"No images found in {in_dir}", file=sys.stderr)
        return 1

    detections: list[Detection] = []
    for i, path in enumerate(image_paths, 1):
        try:
            det, annotated = process_image(path)
        except Exception as exc:
            print(f"[{i}/{len(image_paths)}] ERROR on {path.name}: {exc}",
                  file=sys.stderr)
            det = Detection(
                filename=path.name, detected=False, method="error",
                confidence="", image_width=0, image_height=0,
                card_pixel_width=0.0, card_pixel_height=0.0,
                frame_width_pct=0.0, observed_ratio=0.0, ratio_deviation=0.0,
                corners="", notes=f"exception: {exc}",
            )
            detections.append(det)
            continue

        # Save annotated copy at a manageable size — full-res not needed for review.
        h, w = annotated.shape[:2]
        scale = 1200 / max(h, w) if max(h, w) > 1200 else 1.0
        if scale < 1.0:
            annotated = cv2.resize(annotated, (int(w * scale), int(h * scale)),
                                   interpolation=cv2.INTER_AREA)
        out_path = annotated_dir / path.name
        cv2.imwrite(str(out_path), annotated,
                    [int(cv2.IMWRITE_JPEG_QUALITY), 88])

        detections.append(det)
        status = "OK " if det.detected else "MISS"
        print(f"[{i}/{len(image_paths)}] {status} {path.name} "
              f"method={det.method} conf={det.confidence or '-'} "
              f"ratio={det.observed_ratio} frame%={det.frame_width_pct}")

    # Write CSV.
    fieldnames = list(asdict(detections[0]).keys())
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for det in detections:
            writer.writerow(asdict(det))

    total = len(detections)
    hits = sum(1 for d in detections if d.detected)
    print()
    print(f"=== machine-side summary ===")
    print(f"images:           {total}")
    print(f"detections:       {hits} ({hits / total * 100:.1f}%)")
    print(f"  via otsu:       {sum(1 for d in detections if d.detected and d.method == 'otsu')}")
    print(f"  via canny:      {sum(1 for d in detections if d.detected and d.method == 'canny')}")
    print(f"high confidence:  {sum(1 for d in detections if d.confidence == 'high')}")
    print(f"low confidence:   {sum(1 for d in detections if d.confidence == 'low')}")
    print(f"misses:           {total - hits}")
    print()
    print(f"annotated images: {annotated_dir}")
    print(f"results CSV:      {csv_path}")
    print()
    print("Next step: open the annotated images and fill in the human-review "
          "columns (card_color, card_finish, lighting, correct) in the CSV.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
