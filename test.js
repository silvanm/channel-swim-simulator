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
const SW_PENALTY = 0.25, NE_FREE = 8.0, NE_PENALTY = 0.25;
const score = (r) =>
  (r.landed ? r.hours : 100 + r.minDistFr) +
  SW_PENALTY * r.maxSW + NE_PENALTY * Math.max(0, r.landNE - NE_FREE);

const START = SIM.START_POINTS.shakespeare;
const cfg = (kmh, spring) => ({ startLL: START, speedMs: kmh / 3.6, spring });

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

// 3. no optimal track should end up in the Calais approaches. Wissant bay
//    (~7.5 km NE of the cape) is the normal fallback landing; past that the
//    swimmer is being carried towards the North Sea.
{
  let worst = { ne: -Infinity };
  for (let kmh = 2.0; kmh <= 4.6; kmh += 0.2) {
    for (const spring of [0.41, 0.7, 1.0, 1.2]) {
      const r = SIM.optimize(cfg(kmh, spring), null).optimal.result;
      if (!r.landed) { worst = { ne: Infinity, kmh, spring }; break; }
      if (r.landNE > worst.ne) worst = { ne: r.landNE, kmh, spring };
    }
  }
  check('optimal track always lands at the cape or in Wissant bay',
    worst.ne <= NE_FREE + 0.5,
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

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
