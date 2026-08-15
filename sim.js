/* Channel swim simulation core: tidal current model of the Dover Strait,
 * route integrator, and track optimizer. Pure logic — no DOM. Loadable in
 * the browser (window.SIM) and in node for testing. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KN = 0.514444;          // knots -> m/s
  const T_M2 = 12.4206;         // M2 tidal period, hours
  const W = 2 * Math.PI / T_M2;

  // ---- local flat-earth projection (km), origin mid-strait ----
  const ORIGIN = { lat: 51.0, lng: 1.45 };
  const KY = 111.2;
  const KX = 111.32 * Math.cos(ORIGIN.lat * Math.PI / 180);
  const toXY = (lat, lng) => ({ x: (lng - ORIGIN.lng) * KX, y: (lat - ORIGIN.lat) * KY });
  const toLL = (x, y) => ({ lat: ORIGIN.lat + y / KY, lng: ORIGIN.lng + x / KX });

  // ---- simplified coastlines (lat, lng), used for landfall + masking ----
  // England ordered SW -> NE: water lies to the RIGHT of travel (cross < 0).
  const ENGLAND = [
    [51.0640, 1.1550], [51.0800, 1.1930], [51.0900, 1.2260], [51.0970, 1.2520],
    [51.1005, 1.2740], [51.1060, 1.2960], [51.1130, 1.3200], [51.1200, 1.3440],
    [51.1310, 1.3630], [51.1400, 1.3740], [51.1520, 1.3860], [51.1750, 1.4030],
    [51.2050, 1.4070], [51.2250, 1.4040], [51.2750, 1.3950], [51.3300, 1.4230],
  ];
  // France ordered S -> N -> E (Boulogne -> Gris-Nez -> Calais -> Gravelines):
  // water lies to the LEFT of travel (cross > 0).
  const FRANCE = [
    [50.7270, 1.5735], [50.7405, 1.5960], [50.7690, 1.6060], [50.8035, 1.6005],
    [50.8230, 1.5905], [50.8520, 1.5820], [50.8685, 1.5810], [50.8890, 1.6510],
    [50.9060, 1.6720], [50.9280, 1.7100], [50.9470, 1.7520], [50.9690, 1.8510],
    [50.9830, 1.9650], [51.0000, 2.1000],
  ];
  const CAPE = { lat: 50.8685, lng: 1.5810 };   // Cap Gris-Nez

  const START_POINTS = {
    shakespeare: { name: 'Shakespeare Beach, Dover', lat: 51.1045, lng: 1.3005 },
    samphire:    { name: 'Samphire Hoe',             lat: 51.0985, lng: 1.2760 },
    abbots:      { name: "Abbot's Cliff",            lat: 51.0950, lng: 1.2530 },
  };

  const polyXY = (poly) => poly.map(([la, ln]) => toXY(la, ln));
  const ENG_XY = polyXY(ENGLAND);
  const FRA_XY = polyXY(FRANCE);
  const CAPE_XY = toXY(CAPE.lat, CAPE.lng);

  // distance (km) from point to polyline + side sign of nearest segment
  function nearestSeg(pts, p) {
    let best = { d2: Infinity, side: 0, cx: 0, cy: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + t * dx, cy = a.y + t * dy;
      const ex = p.x - cx, ey = p.y - cy;
      const d2 = ex * ex + ey * ey;
      if (d2 < best.d2) {
        best = { d2, side: Math.sign(dx * (p.y - a.y) - dy * (p.x - a.x)), cx, cy };
      }
    }
    best.d = Math.sqrt(best.d2);
    return best;
  }

  const isWater = (p) =>
    nearestSeg(ENG_XY, p).side < 0 && nearestSeg(FRA_XY, p).side > 0;

  // ---- tidal stream model ----
  // Cross-strait coordinate: baseline through Shakespeare Beach, axis bearing 45 deg.
  const B0 = toXY(51.106, 1.296);
  const AX = { x: Math.SQRT1_2, y: Math.SQRT1_2 };    // NE along-strait
  const PERP = { x: Math.SQRT1_2, y: -Math.SQRT1_2 }; // SE toward France
  const WIDTH = 33; // km England shore -> France shore along PERP

  // temporal signal: t in hours relative to HW Dover. Positive = NE-going (flood).
  // The 0.15*sin(2th) term only skews the peak shape — on its own it leaves the
  // NE and SW halves exactly 6.21 h each with zero net transport. RESIDUAL_NE is
  // the Strait's mean NE set; it is what actually makes the NE-going stream run
  // longer than the SW-going one (here HW-1:39 to HW+4:59, Admiralty ~HW-0130 to
  // ~HW+0445) and leaves a net NE drift over a full cycle.
  const RESIDUAL_NE = 0.10;   // fraction of the local peak rate (~0.2 kn mid-strait)
  function tideSignal(t) {
    const th = W * (t + 1.5);
    return Math.sin(th) + 0.15 * Math.sin(2 * th) + RESIDUAL_NE;
  }

  // current vector (m/s east, north) at km-position p, time t hours after HW Dover
  function current(p, t, spring) {
    const px = p.x - B0.x, py = p.y - B0.y;
    const cross = px * PERP.x + py * PERP.y;              // km from English shore
    const c = Math.max(0, Math.min(1, cross / WIDTH));
    const mid = Math.pow(Math.sin(Math.PI * c), 0.7);     // 0 at shores, 1 mid-strait
    let speedKn = 1.0 + 0.9 * mid;                        // mean-spring peak rates

    // tidal race off Cap Gris-Nez
    const gx = p.x - (CAPE_XY.x - 2.0), gy = p.y - (CAPE_XY.y + 1.5);
    speedKn += 1.1 * Math.exp(-(gx * gx + gy * gy) / (2 * 4.0 * 4.0));

    const mps = speedKn * KN * spring * tideSignal(t);
    // stream axis rotates slightly across the strait (35 deg -> 52 deg)
    const brg = (35 + 17 * c) * Math.PI / 180;
    return { u: mps * Math.sin(brg), v: mps * Math.cos(brg) };
  }

  // ---- route integrator ----
  // opts: { startLL, t0, speedMs, spring, headingFn(elapsedH, posXY), maxHours }
  // headingFn returns bearing in radians (0 = north, clockwise).
  function simulate(opts) {
    const maxH = opts.maxHours || 40;
    let p = toXY(opts.startLL.lat, opts.startLL.lng);
    let elapsed = 0;                    // hours since start
    let distGround = 0;                 // km over ground
    const path = [];
    let minDistFr = Infinity;
    let landed = false, landLL = null;
    let maxSW = 0;                      // km SW of the Cap Gris-Nez along-strait line

    const record = () => {
      const ll = toLL(p.x, p.y);
      path.push({ t: elapsed, lat: ll.lat, lng: ll.lng });
    };
    record();

    let sinceSample = 0;
    while (elapsed < maxH) {
      const fr = nearestSeg(FRA_XY, p);
      if (fr.d < minDistFr) minDistFr = fr.d;
      const along = (p.x - CAPE_XY.x) * AX.x + (p.y - CAPE_XY.y) * AX.y;
      if (-along > maxSW) maxSW = -along;
      if (fr.d < 0.15 || fr.side <= 0) {
        landed = true;
        const ll = toLL(fr.cx, fr.cy);
        landLL = ll;
        p = { x: fr.cx, y: fr.cy };
        record();
        break;
      }
      const dt = fr.d < 1.0 ? 20 : 120;               // s, finer near the coast
      const h = opts.headingFn(elapsed, p);
      const sw = { x: opts.speedMs * Math.sin(h), y: opts.speedMs * Math.cos(h) };

      // RK2 midpoint
      const c1 = current(p, opts.t0 + elapsed, opts.spring);
      const k1 = { x: (sw.x + c1.u) * dt / 1000, y: (sw.y + c1.v) * dt / 1000 };
      const pm = { x: p.x + k1.x / 2, y: p.y + k1.y / 2 };
      const c2 = current(pm, opts.t0 + elapsed + dt / 7200, opts.spring);
      const st = { x: (sw.x + c2.u) * dt / 1000, y: (sw.y + c2.v) * dt / 1000 };

      p = { x: p.x + st.x, y: p.y + st.y };
      distGround += Math.hypot(st.x, st.y);
      elapsed += dt / 3600;
      sinceSample += dt;
      if (sinceSample >= 120) { record(); sinceSample = 0; }
    }
    if (!landed) record();

    const landedAtCape = landed &&
      Math.hypot(toXY(landLL.lat, landLL.lng).x - CAPE_XY.x,
                 toXY(landLL.lat, landLL.lng).y - CAPE_XY.y) < 1.5;

    return {
      landed, hours: elapsed, path, landLL, distGround,
      distWater: opts.speedMs * elapsed * 3.6, minDistFr, landedAtCape, maxSW,
    };
  }

  // Straying SW of the Cap Gris-Nez line puts the swimmer in open water past the
  // cape, where the SW-going stream sets them away from France. Pilots avoid that
  // sector at any cost; without the penalty the optimizer happily picks the
  // mirror-image (ebb-first) start, which scores as well as the real flood-first
  // one because the M2 signal alone is symmetric.
  const SW_PENALTY = 0.25;              // hours of "cost" per km SW of the cape
  const score = (r) =>
    (r.landed ? r.hours : 100 + r.minDistFr) + SW_PENALTY * r.maxSW;

  // ---- strategies ----
  const aimAtCape = () => (e, p) =>
    Math.atan2(CAPE_XY.x - p.x, CAPE_XY.y - p.y);
  const constHeading = (deg) => () => deg * Math.PI / 180;

  const LEG_H = 1.25, N_LEGS = 14;
  const legHeading = (legsDeg) => (e) => {
    const i = Math.min(Math.floor(e / LEG_H), N_LEGS - 1);
    return legsDeg[i] * Math.PI / 180;
  };

  // ---- optimizer ----
  // Finds, for a given swim speed & tide strength: best constant-heading track,
  // best aim-at-cape start time, and a piecewise-heading refined "optimal" track.
  function optimize(cfg, fixedT0) {
    const base = { startLL: cfg.startLL, speedMs: cfg.speedMs, spring: cfg.spring };
    const run = (t0, fn) => simulate({ ...base, t0: ((t0 % T_M2) + T_M2) % T_M2, headingFn: fn });

    const t0List = fixedT0 != null
      ? [fixedT0]
      : Array.from({ length: 13 }, (_, i) => i * T_M2 / 13);

    // stage 1: constant heading grid
    let best = { s: Infinity, th: 145, t0: t0List[0], r: null };
    for (const t0 of t0List) {
      for (let th = 100; th <= 210; th += 6) {
        const r = run(t0, constHeading(th));
        const s = score(r);
        if (s < best.s) best = { s, th, t0, r };
      }
    }
    // refine
    const t0Ref = fixedT0 != null
      ? [fixedT0]
      : [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75].map(d => best.t0 + d);
    for (const t0 of t0Ref) {
      for (let th = best.th - 5; th <= best.th + 5; th += 1.5) {
        const r = run(t0, constHeading(th));
        const s = score(r);
        if (s < best.s) best = { s, th, t0, r };
      }
    }
    const constant = { headingDeg: best.th, t0: best.t0, result: best.r };

    // stage 2: piecewise headings, coordinate descent from the constant solution
    let legs = new Array(N_LEGS).fill(best.th);
    let bt0 = best.t0;
    let bScore = best.s, bRes = best.r;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < N_LEGS; i++) {
        if (bRes.landed && i * LEG_H > bRes.hours + LEG_H) break;
        for (const d of [15, -15, 6, -6, 2, -2]) {
          const trial = legs.slice();
          trial[i] += d;
          const r = run(bt0, legHeading(trial));
          const s = score(r);
          if (s < bScore - 1e-4) { bScore = s; bRes = r; legs = trial; }
        }
      }
      if (fixedT0 == null) {
        for (const d of [-0.25, 0.25]) {
          const r = run(bt0 + d, legHeading(legs));
          const s = score(r);
          if (s < bScore - 1e-4) { bScore = s; bRes = r; bt0 += d; }
        }
      }
    }
    const optimal = { legsDeg: legs, t0: bt0, result: bRes };

    // aim-at-cape reference, own best start time
    let aim = { s: Infinity, t0: 0, r: null };
    const aimT0 = fixedT0 != null
      ? [fixedT0]
      : Array.from({ length: 50 }, (_, i) => i * T_M2 / 50);
    for (const t0 of aimT0) {
      const r = run(t0, aimAtCape());
      const s = score(r);
      if (s < aim.s) aim = { s, t0, r };
    }

    return { constant, optimal, aim: { t0: aim.t0, result: aim.r } };
  }

  return {
    KN, T_M2, ORIGIN, ENGLAND, FRANCE, CAPE, START_POINTS,
    toXY, toLL, isWater, nearestSeg, ENG_XY, FRA_XY,
    tideSignal, current, simulate, optimize,
    aimAtCape, constHeading, legHeading, LEG_H, N_LEGS,
  };
});
