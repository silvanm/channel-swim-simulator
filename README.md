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
  Cap Gris-Nez. A net NE residual makes the NE-going stream run longer
  (HW−1:39 → HW+4:59, Admiralty ~HW−0130 → ~HW+0445) and leaves a mean NE set;
  without it the model is exactly symmetric and flood-first and ebb-first starts
  score the same. Tidal range slider scales neaps↔springs.
- **Simulator** — RK2 integration of swimmer velocity (adjustable speed through
  water) plus the current field; landfall detected against a simplified French
  coastline (landing anywhere counts, as under ratification rules).
- **Optimiser** — Zermelo-style navigation solved pragmatically: grid search
  over start time (relative to HW Dover) and constant heading, then coordinate
  descent over 14 piecewise leg headings. Compare against "aim at Cap Gris-Nez".
  The score penalises straying SW of the Cap Gris-Nez line, the sector where the
  SW stream sets a swimmer away from France and pilots refuse to go.
- **Benchmark** — histogram of 3,074 ratified E→F solos from the public English
  Channel Swim Database (median 13h21m, record 6h45m, 31.8% land on the cape);
  your simulated time is placed on it.
- **Water temperature** — expected sea surface temperature for the chosen date
  from NASA JPL MUR SST v4.1 (1 km) monthly composites, area-averaged over the
  route box and interpolated smoothly through the mid-month values. The expected
  value is the mean of the five most recent years rather than the all-year
  median: the 2015–2026 record carries a ~+1.0 °C/decade trend over Jun–Sep, so
  an all-year median reads ~0.5 °C low today. The quoted spread is the full
  observed min–max. See `260813 Kanal _ SST-Zeitreihe ERDDAP.py`.
- **Calendar mode** — pick a start date: HW Dover comes from an M2+S2+N2
  harmonic model fitted to 56 published Dover high waters (~12 min RMS
  in-sample, ~16 min out-of-sample); the tidal range from the same model sets
  the stream strength. Departure is scheduled near 03:00 (night start), and
  depart/arrive are shown as Dover local (GMT/BST) clock times with a
  daylight-at-landfall check and night shading on the tide strip.

Calibration checks out: 4.5 km/h ≈ 6h52m (record pace), 3.0–3.4 km/h ≈ 9–10.5h
(top decile), 2.5–2.8 km/h ≈ 11–12.5h (median territory).

Validated against a real swim — Bronagh Marley, 14 Aug 2026, Shakespeare Beach →
Cap Gris-Nez in 11h22m starting 00:42 BST (HW−0:15). At 3.1 km/h the optimiser
picks a 01:38 start (HW+0:58) and lands at Cap Gris-Nez after 10h53m, and forcing
the real start time reproduces her track shape (east on the flood, then south).

## Files

- `sim.js` — physics, integrator, optimiser (also loadable in node for tests)
- `app.js` — Leaflet map, tide-arrow overlay, playback, instruments, charts
- `index.html` — UI shell and styling
- `260813 Kanal _ SST-Zeitreihe ERDDAP.py` — pulls the MUR SST series from NOAA
  ERDDAP into `kanal_sst_monatsmittel.csv` (source of the water-temperature table)

Educational toy — not for navigation.

Live: https://silvanm.github.io/channel-swim-simulator/

---
Updated 2026-08-15 · 94dd303
