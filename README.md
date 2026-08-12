# La Manche — Channel Solo Simulator

Browser simulation of an English Channel solo swim (Dover Strait) with a tidal
current model, animated swim path on a real map, and an optimiser that computes
the best track for a given swim speed.

## Run

```
python3 -m http.server 8642
# then open http://localhost:8642/index.html
```

Opening `index.html` directly via `file://` also works (Leaflet loads from CDN,
everything else is local).

## What it does

- **Tidal model** — simplified M2 stream (12.42 h period) aligned with the
  strait axis: ~1.9 kn mid-strait at springs, weaker inshore, a tidal race off
  Cap Gris-Nez, slight flood asymmetry. Tidal range slider scales neaps↔springs.
- **Simulator** — RK2 integration of swimmer velocity (adjustable speed through
  water) plus the current field; landfall detected against a simplified French
  coastline (landing anywhere counts, as under ratification rules).
- **Optimiser** — Zermelo-style navigation solved pragmatically: grid search
  over start time (relative to HW Dover) and constant heading, then coordinate
  descent over 14 piecewise leg headings. Compare against "aim at Cap Gris-Nez".
- **Benchmark** — histogram of 3,074 ratified E→F solos from the public English
  Channel Swim Database (median 13h21m, record 6h45m, 31.8% land on the cape);
  your simulated time is placed on it.
- **Calendar mode** — pick a start date: moon phase sets the spring/neap
  strength, HW Dover is approximated from lunar transit (±1 h), departure is
  scheduled near 03:00 (night start), and depart/arrive are shown as clock
  times with a daylight-at-landfall check and night shading on the tide strip.

Calibration checks out: 4.5 km/h ≈ 6h52m (record pace), 3.0–3.4 km/h ≈ 9–10.5h
(top decile), 2.5–2.8 km/h ≈ 11–12.5h (median territory).

## Files

- `sim.js` — physics, integrator, optimiser (also loadable in node for tests)
- `app.js` — Leaflet map, tide-arrow overlay, playback, instruments, charts
- `index.html` — UI shell and styling

Educational toy — not for navigation.

---
Created 2026-08-12 · no git repo (scratchpad project)
