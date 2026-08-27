/* Regression tests for the optimizer. Run with: node test.js
 *
 * The one that matters is `optimizer beats a brute-force constant heading`.
 * The score surface over (start time, heading) is bimodal — one well lands on
 * Cap Gris-Nez, the other slides past it into Wissant bay — and the two are
 * only minutes apart with a ridge between them. An optimizer that follows a
 * single best-of-grid point downhill silently settles in whichever well the
 * grid happened to sample better, which is how the Cap Gris-Nez track used to
 * go missing for some speed/tide combinations. */
'use strict';
const SIM = require('./sim.js');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

// mirror of the optimizer's own objective
const SW_PENALTY = 0.25, NE_FREE = 1.5, NE_PENALTY = 0.25;
const score = (r) =>
  (r.landed ? r.hours : 100 + r.minDistFr) +
  SW_PENALTY * r.maxSW + NE_PENALTY * Math.max(0, r.landNE - NE_FREE);

const START = SIM.START_POINTS.shakespeare;
const cfg = (kmh, spring, fade) => ({ startLL: START, speedMs: kmh / 3.6, spring, fade });

function bestConstant(kmh, spring, t0) {
  let best = { s: Infinity };
  for (let th = 95; th <= 215; th += 1) {
    const r = SIM.simulate({ ...cfg(kmh, spring), t0, headingFn: SIM.constHeading(th) });
    const s = score(r);
    if (s < best.s) best = { s, th, r };
  }
  return best;
}

// 1. the optimizer must never lose to a plain 1-degree constant-heading scan.
//    A piecewise-heading track can always fall back on a constant heading, so
//    losing means the search got stuck.
{
  let worst = { gap: -Infinity };
  for (const kmh of [2.0, 2.4, 2.8, 3.2, 3.6, 4.2]) {
    for (const spring of [0.41, 0.7, 1.0, 1.2]) {
      for (const t0 of [0, 2.07, 4.14, 6.21, 8.28, 10.35]) {
        const opt = SIM.optimize(cfg(kmh, spring), t0).optimal.result;
        const gap = score(opt) - bestConstant(kmh, spring, t0).s;
        if (gap > worst.gap) worst = { gap, kmh, spring, t0 };
      }
    }
  }
  check('optimizer beats a brute-force constant heading', worst.gap < 0.02,
    `worst shortfall ${worst.gap.toFixed(3)} h at ${worst.kmh} km/h, ` +
    `spring ${worst.spring}, HW+${worst.t0.toFixed(2)}`);
}

// 2. the case that first exposed the trap: the grid samples 136 deg (Wissant
//    well, 14.73) and 142 deg (14.77) but the real optimum is 146 deg (cape,
//    14.43), out of reach of a local polish around 136.
{
  const r = SIM.optimize(cfg(2.4, 1.0), 9.32).optimal.result;
  check('2.4 km/h, springs, HW+9:19 finds the Cap Gris-Nez well',
    r.landedAtCape, `landed ${r.landLL.lat.toFixed(3)}N ${r.landLL.lng.toFixed(3)}E ` +
    `in ${r.hours.toFixed(2)} h`);
}

// 3. every strategy the UI can show should land on the cape. Checking only the
//    optimised track missed this once already: the constant-heading track is a
//    separate answer with its own landfall, and that is the one the UI was
//    showing when a landing 7.5 km up the coast in Wissant bay turned up.
for (const strategy of ['optimal', 'constant']) {
  let worst = { ne: -Infinity };
  // tenths as the loop index: `kmh += 0.2` accumulates error and stops at 4.4
  for (let tenths = 20; tenths <= 46; tenths += 2) {
    const kmh = tenths / 10;
    for (const spring of [0.41, 0.7, 1.0, 1.2]) {
      const r = SIM.optimize(cfg(kmh, spring), null)[strategy].result;
      if (!r.landed) { worst = { ne: Infinity, kmh, spring }; break; }
      if (r.landNE > worst.ne) worst = { ne: r.landNE, kmh, spring };
    }
  }
  check(`${strategy} track always lands on Cap Gris-Nez`,
    worst.ne <= NE_FREE,
    `furthest landfall ${worst.ne.toFixed(1)} km NE of the cape line ` +
    `at ${worst.kmh.toFixed(1)} km/h, spring ${worst.spring}`);
}

// 4. calibration anchor: Bronagh Marley, 14 Aug 2026, Shakespeare Beach ->
//    Cap Gris-Nez in 11h22m. At her 3.1 km/h the optimizer should land on the
//    cape in roughly that time.
{
  const R = SIM.optimize(cfg(3.1, 1.0), null);
  const r = R.optimal.result;
  check('3.1 km/h on springs reproduces the Marley crossing',
    r.landedAtCape && r.hours > 10 && r.hours < 12,
    `${r.hours.toFixed(2)} h, start HW+${R.optimal.t0.toFixed(2)}, ` +
    (r.landedAtCape ? 'Cap Gris-Nez' : 'not the cape'));
}

// 5. the fade model. `fade` is the fraction of the starting speed lost by the
//    end, approached exponentially with a 6 h time constant.
{
  const v0 = 3.0;
  const at = (t) => SIM.speedAt(v0, 0.12, t);
  check('fade leaves the starting speed untouched at t=0', Math.abs(at(0) - v0) < 1e-12);
  check('fade is monotonic and bounded below by the floor',
    at(1) < at(0) && at(12) < at(1) && at(1e6) > v0 * 0.12 * 0.99,
    `${at(0).toFixed(2)} -> ${at(6).toFixed(2)} @6h -> ${at(12).toFixed(2)} @12h ` +
    `-> floor ${(v0 * 0.88).toFixed(2)}`);
  check('fade 0 is a no-op', SIM.speedAt(v0, 0, 12) === v0 && SIM.speedAt(v0, undefined, 12) === v0);
}

// 6. no stall at the slow tail. This is the whole reason the decline is
//    exponential-to-a-floor rather than linear: a linear 0.05 km/h per hour
//    caps lifetime water distance at v0^2/2k, which sends a 1.8 km/h swimmer to
//    30h52 (vs 18h07 unfatigued) and stops a 1.6 km/h one finishing at all.
{
  const r = SIM.optimize(cfg(1.9, 1.0, 0.12), null).optimal.result;
  check('a very slow swimmer still lands, and never below the floor',
    r.landed && r.hours < 20 && r.endSpeed > 1.9 * 0.88 - 1e-9,
    `${r.hours.toFixed(2)} h, finishing at ${r.endSpeed.toFixed(2)} km/h`);
}

// 7. re-basing. Fade makes the speed input the speed at the *start*, so the
//    calibration has to move with it: a swim that used to be entered as a
//    2.8 km/h constant is a 3.0 km/h start fading 12%, and must still take
//    about as long. If this drifts, every calibration figure in the README and
//    the placement on the benchmark histogram is off.
for (const [flat, start] of [[2.4, 2.57], [2.8, 3.0], [3.1, 3.32], [3.6, 3.85]]) {
  const a = SIM.optimize(cfg(flat, 1.0), null).optimal.result;
  const b = SIM.optimize(cfg(start, 1.0, 0.12), null).optimal.result;
  check(`${start} km/h fading 12% matches a flat ${flat} km/h`,
    Math.abs(b.meanSpeed - flat) < 0.05 && Math.abs(b.hours - a.hours) < 0.25,
    `${a.hours.toFixed(2)} h flat vs ${b.hours.toFixed(2)} h fading ` +
    `(mean ${b.meanSpeed.toFixed(2)} km/h)`);
}

// 8. the Marley anchor again, in the re-based units: 3.1 km/h average is a
//    3.3 km/h start with the default fade.
{
  const R = SIM.optimize(cfg(3.3, 1.0, 0.12), null);
  const r = R.optimal.result;
  check('3.3 km/h start, 12% fade reproduces the Marley crossing',
    r.landedAtCape && r.hours > 10 && r.hours < 12,
    `${r.hours.toFixed(2)} h, mean ${r.meanSpeed.toFixed(2)} km/h, ` +
    `start HW+${R.optimal.t0.toFixed(2)}`);
}

// 9. distWater is integrated now, not speed*time. With no fade the two must
//    still agree, or the "through water" figure silently changed meaning.
{
  const r = SIM.simulate({
    ...cfg(2.8, 1.0), t0: 4.0, headingFn: SIM.constHeading(140),
  });
  check('distWater with no fade is still speed x time',
    Math.abs(r.distWater - 2.8 * r.hours) < 0.05,
    `${r.distWater.toFixed(2)} km vs ${(2.8 * r.hours).toFixed(2)} km`);
}

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
