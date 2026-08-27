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
- **Fatigue** — swimmers do not hold one speed for thirteen hours, so speed
  through water fades exponentially towards a floor,
  `v(t) = v0 · (1 − fade · (1 − e^(−t/6h)))`, losing `fade` of the starting speed
  (default 12%) with a 6 h time constant. At the 3.0 km/h default that is
  ~0.06 km/h per hour at first, settling near 2.64 km/h. The obvious first guess
  — a constant linear decay, say 0.05 km/h per hour — is wrong at the tail: it
  has no floor, so the distance a swimmer can ever cover through water is capped
  at v0²/2k. Linear decay sends a 1.8 km/h swimmer to 30h52m instead of 18h07m
  and stops a 1.6 km/h one finishing at all, which is an artefact of the
  functional form rather than physiology.
  The speed slider is therefore the speed at the *start*, not the average — the
  panel shows the mean the swim actually works out to, which is what the
  benchmark histogram compares against. A swim that used to be entered as a flat
  2.8 km/h is a 3.0 km/h start fading 12%.
  Worth knowing: at matched *mean* speed, fade barely moves the optimal track.
  Across 2.4–3.6 km/h the chosen start time is identical and the leg headings
  shift by 1–2°, because the tidal phase relative to the crossing duration is
  what sets the track, and that is unchanged when the mean is held. Fade changes
  how you read the speed number and it lengthens the crossing; it does not change
  the plan.
- **Optimiser** — Zermelo-style navigation solved pragmatically: grid search
  over start time (relative to HW Dover) and constant heading, then coordinate
  descent over 14 piecewise leg headings. Compare against "aim at Cap Gris-Nez".
  The search is **multi-start**, which matters: the score surface over (start
  time, heading) is bimodal. One well lands on Cap Gris-Nez, the other slides
  past it into Wissant bay, and the two sit minutes apart with a ridge between
  them — at 2.4 km/h on springs, HW+9:19, the headings score 136° → 14.73 h
  (Wissant) but 146° → 14.43 h (the cape), with 140° → 14.88 h in between.
  Following the single best grid cell downhill therefore settled in whichever
  well the grid happened to sample better and could never cross back, which is
  how the Cap Gris-Nez track went missing for some speed/tide combinations. So
  the search seeds from the best four separated local minima of the grid rather
  than the single best cell; each is refined and run through its own coordinate
  descent, and the best result wins.
  The score penalises straying SW of the Cap Gris-Nez line, the sector where the
  SW stream sets a swimmer away from France and pilots refuse to go, and at the
  same rate a landfall NE of it — symmetric about the cape, with a dead zone no
  wider than the 1.5 km radius that already counts as landing on it. The cape is
  the nearest point of France and the target every crossing is planned around,
  and holding it is close to free: across the speed/tide grid it costs nothing at
  all in two thirds of cases and at most 18 min anywhere. The penalty stays soft,
  so a swimmer who genuinely cannot hold the cape still lands in Wissant bay
  behind it rather than nowhere.
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

Calibration checks out (starting speeds, springs, mean speed in brackets):
4.8 km/h ≈ 7h22m (mean 4.56 — record pace), 3.45–3.65 km/h ≈ 9h47m–10h25m
(mean 3.2–3.4, top decile), 2.9–3.2 km/h ≈ 11h24m–13h01m (mean 2.7–3.0, median
territory).

Validated against a real swim — Bronagh Marley, 14 Aug 2026, Shakespeare Beach →
Cap Gris-Nez in 11h22m starting 00:42 BST (HW−0:15). At a 3.3 km/h start with
the default fade — a 3.1 km/h average, her real pace — the optimiser picks a
HW+0:35 start and lands at Cap Gris-Nez after 10h59m; forcing her real start
time gives 11h11m to the cape with the same track shape (east on the flood, then
south). The same anchor held before fade existed, at a flat 3.1 km/h: 10h54m
optimised, 11h07m forced.

## Files

- `sim.js` — physics, integrator, optimiser (also loadable in node for tests)
- `test.js` — regression tests for the optimiser: `node test.js` (~45 s)
- `app.js` — Leaflet map, tide-arrow overlay, playback, instruments, charts
- `index.html` — UI shell and styling
- `260813 Kanal _ SST-Zeitreihe ERDDAP.py` — pulls the MUR SST series from NOAA
  ERDDAP into `kanal_sst_monatsmittel.csv` (source of the water-temperature table)

Educational toy — not for navigation.

Live: https://silvanm.github.io/channel-swim-simulator/

---
Updated 2026-08-27 · ece72e0
