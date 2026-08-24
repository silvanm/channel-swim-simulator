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

  // Per-segment constants, cached per polyline: nearestSeg sits in the
  // integrator's inner loop and the optimizer calls it a few hundred thousand
  // times per recompute, so recomputing dx/dy/len2 every step is not free.
  const SEG_CACHE = new WeakMap();   // weak: a caller may pass throwaway polylines
  function segments(pts) {
    let segs = SEG_CACHE.get(pts);
    if (segs) return segs;
    segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      segs.push({ ax: a.x, ay: a.y, dx, dy, inv: 1 / (dx * dx + dy * dy) });
    }
    SEG_CACHE.set(pts, segs);
    return segs;
  }

  // distance (km) from point to polyline + side sign of nearest segment
  function nearestSeg(pts, p) {
    const segs = segments(pts);
    let bd2 = Infinity, bside = 0, bcx = 0, bcy = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const rx = p.x - s.ax, ry = p.y - s.ay;
      let t = (rx * s.dx + ry * s.dy) * s.inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = s.ax + t * s.dx, cy = s.ay + t * s.dy;
      const ex = p.x - cx, ey = p.y - cy;
      const d2 = ex * ex + ey * ey;
      if (d2 < bd2) {
        bd2 = d2; bcx = cx; bcy = cy;
        bside = Math.sign(s.dx * ry - s.dy * rx);
      }
    }
    return { d2: bd2, d: Math.sqrt(bd2), side: bside, cx: bcx, cy: bcy };
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

    // how far up-Channel of the Cap Gris-Nez line the landfall is: 0 at the
    // cape, ~7.5 km at Wissant, ~15 km at Sangatte, ~21 km at Calais
    let landNE = 0;
    if (landed) {
      const lp = toXY(landLL.lat, landLL.lng);
      landNE = Math.max(0, (lp.x - CAPE_XY.x) * AX.x + (lp.y - CAPE_XY.y) * AX.y);
    }

    return {
      landed, hours: elapsed, path, landLL, distGround,
      distWater: opts.speedMs * elapsed * 3.6, minDistFr, landedAtCape, maxSW,
      landNE,
    };
  }

  // Straying SW of the Cap Gris-Nez line puts the swimmer in open water past the
  // cape, where the SW-going stream sets them away from France. Pilots avoid that
  // sector at any cost; without the penalty the optimizer happily picks the
  // mirror-image (ebb-first) start, which scores as well as the real flood-first
  // one because the M2 signal alone is symmetric.
  const SW_PENALTY = 0.25;              // hours of "cost" per km SW of the cape
  // Overshooting NE past the cape is the other half of the same preference, and
  // used to cost nothing. Cap Gris-Nez is the nearest point of France and the
  // target every crossing is planned around, so the penalty is symmetric about
  // it: same 0.25 h/km as the SW side, with a dead zone no wider than the radius
  // that already counts as landing on the cape.
  //
  // An earlier version left the whole of Wissant bay (8 km) free, on the
  // grounds that it is the normal fallback landing. That was miscalibrated:
  // holding the cape instead costs nothing at all in two thirds of the
  // speed/tide grid and at most 18 min anywhere in it, so the free zone bought
  // no realism and just handed the bay every crossing it happened to win by a
  // quarter of an hour. The penalty stays soft — a swimmer who genuinely cannot
  // hold the cape still lands in the bay rather than nowhere.
  const NE_FREE = 1.5;                  // km NE of the cape line — the cape's own radius
  const NE_PENALTY = 0.25;              // hours per km beyond that
  const score = (r) =>
    (r.landed ? r.hours : 100 + r.minDistFr) +
    SW_PENALTY * r.maxSW +
    NE_PENALTY * Math.max(0, r.landNE - NE_FREE);

  // ---- strategies ----
  const constHeading = (deg) => () => deg * Math.PI / 180;

  const LEG_H = 1.25, N_LEGS = 14;
  const legHeading = (legsDeg) => (e) => {
    const i = Math.min(Math.floor(e / LEG_H), N_LEGS - 1);
    return legsDeg[i] * Math.PI / 180;
  };

  // ---- optimizer ----
  // Finds, for a given swim speed & tide strength, the best constant-heading
  // track and the piecewise-heading "optimal" track refined from it.
  //
  // The score surface over (start time, heading) is bimodal, and the two wells
  // sit only minutes apart. One lands on Cap Gris-Nez; the other slides past it
  // and lands in Wissant bay or further NE towards Sangatte. Between them is a
  // ridge: at 2.4 km/h on springs, HW+9:19, the headings score 130 -> 14.89,
  // 136 -> 14.73 (Wissant well), 142 -> 14.77, 146 -> 14.43 (cape well). A
  // best-of-grid pick followed by one local polish therefore locks onto
  // whichever well the grid happened to sample better and can never cross back,
  // which is why the cape solution used to go missing for some speed/tide
  // combinations. So: seed the search from the best few separated local minima
  // of the coarse grid — N_SEEDS of them, not just the single best cell —
  // refine each one, and let them compete.
  //
  // The grid only has to resolve the wells, not their bottoms — the polish and
  // the coordinate descent do that. The wells sit ~10 deg apart.
  const TH_LO = 95, TH_HI = 215, TH_STEP = 4;
  const N_T0 = 16;                 // start-time samples over one M2 cycle
  const N_SEEDS = 4;               // most wells the grid may hand on as seeds
  const SEED_MARGIN = 0.75;        // h — wells this far behind the best are hopeless

  // The best `limit` local minima of a 2-D score grid, best first. Rows are
  // start times (cyclic when the grid spans a whole tidal cycle), columns
  // headings (not cyclic). Ties count as minima, so a flat plateau yields cells
  // rather than none; the separation filter then keeps only the best of each
  // cluster, so one plateau cannot crowd a genuinely different well out of the
  // seed list.
  function gridSeeds(grid, cyclicRows, limit) {
    const nR = grid.length, nC = grid[0].length, mins = [];
    for (let i = 0; i < nR; i++) {
      for (let j = 0; j < nC; j++) {
        const s = grid[i][j];
        if (!isFinite(s)) continue;
        let isMin = true;
        for (let di = -1; di <= 1 && isMin; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            if (!di && !dj) continue;
            let ni = i + di;
            if (cyclicRows) ni = (ni + nR) % nR;
            else if (ni < 0 || ni >= nR) continue;
            const nj = j + dj;
            if (nj < 0 || nj >= nC) continue;
            if (grid[ni][nj] < s) { isMin = false; break; }
          }
        }
        if (isMin) mins.push({ i, j, s });
      }
    }
    mins.sort((a, b) => a.s - b.s);
    const out = [];
    for (const m of mins) {
      if (out.length >= limit) break;
      const near = out.some((o) => {
        let di = Math.abs(o.i - m.i);
        if (cyclicRows) di = Math.min(di, nR - di);
        return di <= 1 && Math.abs(o.j - m.j) <= 1;
      });
      if (!near) out.push(m);
    }
    return out;
  }

  function optimize(cfg, fixedT0) {
    const base = { startLL: cfg.startLL, speedMs: cfg.speedMs, spring: cfg.spring };
    const wrapT0 = (t0) => ((t0 % T_M2) + T_M2) % T_M2;
    const run = (t0, fn) => simulate({ ...base, t0: wrapT0(t0), headingFn: fn });

    const t0List = fixedT0 != null
      ? [fixedT0]
      : Array.from({ length: N_T0 }, (_, i) => i * T_M2 / N_T0);
    const thList = [];
    for (let th = TH_LO; th <= TH_HI; th += TH_STEP) thList.push(th);

    // stage 1: constant-heading grid, then one seed per well. Every cell runs to
    // the full horizon: shortening it once some earlier cell has landed would
    // score a late-landing cell as a non-crossing (100+) and drop its well
    // outright, and which cells that hits would depend on traversal order —
    // the same silent well loss this whole rewrite is here to stop. It bought
    // ~13% of the search; not worth it.
    const grid = t0List.map(t0 => thList.map(th => score(run(t0, constHeading(th)))));
    const seeds = gridSeeds(grid, fixedT0 == null, N_SEEDS);

    // stage 1b: polish each seed inside its own well by successive halving
    const dT0 = T_M2 / N_T0;
    const polished = seeds.map(({ i, j }) => {
      let best = { s: grid[i][j], t0: t0List[i], th: thList[j], r: null };
      let spanT = fixedT0 != null ? 0 : dT0, spanH = TH_STEP;
      for (let pass = 0; pass < 3; pass++) {
        const t0s = spanT ? [best.t0 - spanT, best.t0, best.t0 + spanT] : [best.t0];
        const ths = [best.th - spanH, best.th, best.th + spanH];
        let local = { s: Infinity };
        for (const t0 of t0s) {
          for (const th of ths) {
            const r = run(t0, constHeading(th));
            const s = score(r);
            if (s < local.s) local = { s, t0, th, r };
          }
        }
        if (local.s <= best.s) best = local;
        spanT /= 2; spanH /= 2;
      }
      if (!best.r) { best.r = run(best.t0, constHeading(best.th)); best.s = score(best.r); }
      return best;
    }).sort((a, b) => a.s - b.s);

    const bc = polished[0];
    const constant = { headingDeg: bc.th, t0: wrapT0(bc.t0), result: bc.r };

    // stage 2: piecewise headings, coordinate descent run from every seed —
    // the well that wins on a constant heading is not always the one that wins
    // once the legs are free to bend
    let bestOpt = null;
    const contenders = polished.filter(w => w.s <= polished[0].s + SEED_MARGIN);
    for (const seed of contenders) {
      let legs = new Array(N_LEGS).fill(seed.th);
      let bt0 = seed.t0, bScore = seed.s, bRes = seed.r;
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
      if (!bestOpt || bScore < bestOpt.s - 1e-6) {
        bestOpt = { s: bScore, legsDeg: legs, t0: wrapT0(bt0), result: bRes };
      }
    }
    const optimal = { legsDeg: bestOpt.legsDeg, t0: bestOpt.t0, result: bestOpt.result };

    return { constant, optimal };
  }

  return {
    KN, T_M2, ORIGIN, ENGLAND, FRANCE, CAPE, START_POINTS,
    toXY, toLL, isWater, nearestSeg, ENG_XY, FRA_XY,
    tideSignal, current, simulate, optimize,
    constHeading, legHeading, LEG_H, N_LEGS,
  };
});
