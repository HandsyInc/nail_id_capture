# nail-measure-service

Phase 1 local proof for **Layer 2A.1 Absolute Width**.

Implements the validated V1 width pipeline as a self-contained FastAPI microservice:

```
image  →  [SAM2 segmentation]  →  contour_px
       →  homography (H)        →  contour_mm
       →  Shapely MRR           →  (width_raw, length_raw, angle)
       →  depth correction      →  width_mm_final
```

---

## Setup (local machine)

```bash
cd nail-measure-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## Run the service

```bash
uvicorn main:app --reload --port 8001
```

Health check:
```bash
curl http://localhost:8001/health
```

Swagger UI: http://localhost:8001/docs

---

## Phase 1 test (no SAM2 required)

The test uses the V01 Left Middle contour from uw-handsy as a math fixture.
Expected result: **12.16mm ± 0.10mm** (matches V1 benchmark, h=25, D=269).

```bash
python3 test_phase1.py
```

Expected output:
```
[PASS ✓]  Shapely MRR + depth on V1 mm coords     got=12.16mm
[PASS ✓]  px→H→mm→MRR→depth (V01)                 got=12.16mm
[PASS ✓]  HTTP /measure round-trip                  got=12.16mm
Phase 1 proof: ALL PASS — service math layer matches V1 ✓
```

---

## Phase 1 API call (with contour override)

```bash
curl -X POST http://localhost:8001/measure \
  -F "image=@/path/to/IMG_4591 mid left.jpg" \
  -F 'H_matrix=[[0.07335,0.000301,-154.615],[-0.001628,0.07038,-167.403],[-2.328e-6,2.216e-6,1.0]]' \
  -F "h_mm=25" \
  -F "D_mm=269" \
  -F 'contour_px=[[x0,y0],[x1,y1],...]'
```

---

## Phase 2 (next step)

Replace the `contour_px` override with real SAM2 segmentation:
1. Install `sam2` or `handsy_sam2` (from phase_3 Docker image)
2. Pass `positive_points` (nail plate prompt coordinates) instead of `contour_px`
3. `segment.py` will call SAM2 automatically when the model is present

No changes to `measure.py`, `main.py` endpoint contract, or the response schema.

---

## Architecture position

```
Next.js (V2 app)
  └─ POST /measure ──────────────▶  nail-measure-service  (this service)
        image bytes                       SAM2 segmentation
        H_matrix (from card detection)    Shapely MRR
        h_mm, D_mm                        depth correction
                                          ◀── width_mm (JSON)
```

The service does **not** connect to Neon or Prisma.
Persistence of `width_mm` is handled by the Next.js app (Phase 2).

---

## Files

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app, `POST /measure` endpoint |
| `measure.py` | Core math: px→mm, Shapely MRR, depth correction |
| `segment.py` | SAM2 interface (stub in Phase 1, real in Phase 2) |
| `requirements.txt` | Python dependencies |
| `test_phase1.py` | Phase 1 end-to-end test suite |
| `fixtures/V01_LEFT_Straight_left_Middle.csv` | V1 contour used as test fixture |
