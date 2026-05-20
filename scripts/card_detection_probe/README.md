# Offline card-detection probe

A one-script experiment that runs a classical-CV card detector over existing
pilot capture photos and emits annotated images + a CSV for human review.

This exists to answer a single question before we build the larger
`/capture-v2` live overlay: **can we reliably detect a standard dark
credit/debit/loyalty card in real Handsy captures using classical CV?**

It is intentionally not part of the shipped app. It runs locally, in Python.
Nothing here touches the Next.js build or the production capture path.

## Usage

```bash
pip install opencv-python-headless numpy Pillow

python scripts/card_detection_probe/probe.py \
    --input  pilot-samples/ \
    --output scripts/card_detection_probe/output/
```

Outputs:

- `output/annotated/` — one annotated copy per input image (green quadrilateral
  if detected with high confidence, yellow if detected with low confidence,
  red "NO DETECTION" banner if the detector found nothing plausible).
- `output/results.csv` — one row per image. The first set of columns is filled
  in by the script (`detected`, `method`, `confidence`, geometry metrics,
  `notes`). The last four columns are blank for human review:
    - `card_color`  — `dark` / `medium` / `light`
    - `card_finish` — `matte` / `glossy` / `metallic`
    - `lighting`    — `even` / `shadowed` / `glare`
    - `correct`     — `yes` (the box is on the card) / `no` (false positive) /
                       `missed` (detector said no, but a card is clearly present)

## How to read the output

The script prints a machine-side summary at the end — detection rate, branch
breakdown (Otsu vs Canny fallback), confidence split, miss count. That is the
detector's *self-reported* result and is not the same as reliability. The
reliability number requires the human review pass on the `correct` column.

The 30-second-per-image review pass is the load-bearing step here. Without
it, all we have is "the detector thinks it found something" — which can be
wrong in both directions.

## Pipeline

The detector tries two branches in order and takes the first plausible result:

1. **Otsu binarization** — threshold the grayscale image, morphologically
   close gaps (text, chip, glare), find external contours, approximate to
   polygons, keep 4-vertex convex polygons whose aspect ratio is within
   tolerance of the ISO/IEC 7810 ID-1 ratio (~1.586:1) and whose area is
   between 1% and 60% of the image.
2. **Canny edges fallback** — Gaussian blur, Canny with auto-tuned
   thresholds based on image median intensity, dilate to close fragments,
   same contour-approximation / aspect / area gates as branch 1.

Both branches run on a downsampled copy (1200px long edge) for speed.
Detected corners are rescaled back to full-resolution before being recorded
in the CSV so downstream consumers see pixel coordinates in the source
image's coordinate space.

Confidence is a crude heuristic: `high` if the observed aspect ratio is
within ±0.15 of the true ratio AND the card covers ≥4% of the image; `low`
otherwise. This is for prioritizing reviewer attention, not a reliability
claim.

## Why this shape

The whole point of running offline rather than in the browser is iteration
speed. Algorithm tweaks here cost seconds, not a Next.js dev-server cycle.
If this probe says classical CV is viable on real pilot photos, we port the
validated algorithm to JS for the live overlay. If it doesn't, we know
without having built the browser scaffolding around a detector that can't
do its job.
