/* UI layer: Leaflet map, animated tide field, controls, instruments, benchmark. */
'use strict';

// ---- reference data extracted from the CS&PF/CSA public solo database ----
const REAL = {
  count: 3074, fastest: 6.76, median: 13.35, p10: 10.31, p90: 16.82, gnPct: 31.8,
  // 1-h bins of E->F solo durations, first bin = 6-7 h
  bins: [3, 15, 63, 161, 275, 399, 457, 473, 412, 319, 209, 127, 61, 40, 28, 13, 12, 7],
  binStart: 6,
};

// ---- calendar astronomy: moon phase -> tide strength, HW Dover, sun ----
// Approximations good to ~1 h; all clock times are naive UK local time.
const ASTRO = (() => {
  const SYN = 29.530588853;                       // synodic month, days
  const NM = Date.UTC(2000, 0, 6, 18, 14);        // reference new moon
  const TRANSIT_LAG = 0.8412;                     // h/day the moon transits later
  const HW_INTERVAL = 11.117;                     // HW Dover ~11h07 after lunar transit

  const ageAt = (ms) => (((ms - NM) / 86400000) % SYN + SYN) % SYN;

  // spring/neap factor, peaking ~1.8 days after new/full moon
  function springFactor(ms) {
    const f = 0.90 + 0.35 * Math.cos(2 * Math.PI * (ageAt(ms) - 1.8) / (SYN / 2));
    return Math.max(0.55, Math.min(1.25, f));
  }
  function moonInfo(ms) {
    const a = ageAt(ms);
    const names = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous',
      'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
    const emo = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    const i = Math.round(a / SYN * 8) % 8;
    return { age: a, name: names[i], emoji: emo[i] };
  }
  // HW Dover instants (ms) around a local date midnight
  function hwTimes(dayStartMs) {
    const a = ageAt(dayStartMs + 12 * 3600e3);
    const transitH = (12 + a * TRANSIT_LAG) % 24;
    const anchor = dayStartMs + (transitH + HW_INTERVAL) * 3600e3;
    const P = SIM.T_M2 * 3600e3;
    const out = [];
    for (let k = -4; k <= 4; k++) out.push(anchor + k * P);
    return out;
  }
  function sun(dayStartMs) {
    const d = new Date(dayStartMs);
    const start = new Date(d.getFullYear(), 0, 0);
    const doy = Math.round((dayStartMs - start.getTime()) / 86400000);
    const phi = 51.05 * Math.PI / 180;
    const dec = -23.44 * Math.PI / 180 * Math.cos(2 * Math.PI * (doy + 10) / 365);
    const cw = Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec)));
    const half = Math.acos(cw) * 180 / Math.PI / 15;
    const noonH = 12.92;                          // solar noon Dover in BST
    return { rise: noonH - half, set: noonH + half };
  }
  return { ageAt, springFactor, moonInfo, hwTimes, sun };
})();

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const state = {
  useDate: true,
  dateStr: todayStr(),
  astro: null,        // {dayStart, hws, sun, moon}
  speedKmh: 2.8,
  spring: 1.0,
  startKey: 'shakespeare',
  strategy: 'optimal',
  manualStart: false,
  t0Manual: 4.0,
  results: null,      // output of SIM.optimize
  view: null,         // currently displayed run {result, t0, headingFn, label}
  ghost: null,
  playing: false,
  simT: 0,            // hours since start of swim
  playSpeed: 1200,
};

const $ = (id) => document.getElementById(id);
const fmtH = (h) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtHW = (t) => {
  let x = ((t % SIM.T_M2) + SIM.T_M2) % SIM.T_M2;
  if (x > SIM.T_M2 / 2) x -= SIM.T_M2;
  const s = x >= 0 ? '+' : '−';
  const a = Math.abs(x);
  return `HW${s}${Math.floor(a)}:${String(Math.round((a % 1) * 60)).padStart(2, '0')}`;
};

// ---- map ----
const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView([50.99, 1.45], 10);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 15,
}).addTo(map);

// model coastline (the landfall line the simulation actually uses)
const coastStyle = { color: '#f2e9d8', weight: 1, opacity: 0.35, dashArray: '2 5', interactive: false };
L.polyline(SIM.ENGLAND, coastStyle).addTo(map);
L.polyline(SIM.FRANCE, coastStyle).addTo(map);
L.circleMarker([SIM.CAPE.lat, SIM.CAPE.lng], {
  radius: 4, color: '#f2e9d8', weight: 1.5, fillColor: '#0a1220', fillOpacity: 1, interactive: false,
}).addTo(map).bindTooltip('Cap Gris-Nez', { permanent: true, direction: 'right', className: 'cape-label', offset: [6, 0] });

// ---- tide arrows overlay (plain canvas synced to the map pane) ----
const arrowCanvas = document.createElement('canvas');
arrowCanvas.id = 'arrows';
map.getContainer().appendChild(arrowCanvas);
const actx = arrowCanvas.getContext('2d');

function drawArrows() {
  const sz = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  if (arrowCanvas.width !== sz.x * dpr) {
    arrowCanvas.width = sz.x * dpr; arrowCanvas.height = sz.y * dpr;
    arrowCanvas.style.width = sz.x + 'px'; arrowCanvas.style.height = sz.y + 'px';
  }
  actx.setTransform(dpr, 0, 0, dpr, 0, 0);
  actx.clearRect(0, 0, sz.x, sz.y);
  const tAbs = (state.view ? state.view.t0 : 0) + state.simT;
  const step = 54;
  for (let px = step / 2; px < sz.x; px += step) {
    for (let py = step / 2; py < sz.y; py += step) {
      const ll = map.containerPointToLatLng([px, py]);
      if (ll.lat < 50.70 || ll.lat > 51.36 || ll.lng < 1.10 || ll.lng > 2.12) continue;
      const xy = SIM.toXY(ll.lat, ll.lng);
      if (!SIM.isWater(xy)) continue;
      const c = SIM.current(xy, tAbs, state.spring);
      const mag = Math.hypot(c.u, c.v);
      const kn = mag / SIM.KN;
      if (kn < 0.08) {
        actx.fillStyle = 'rgba(79,195,232,0.35)';
        actx.beginPath(); actx.arc(px, py, 1.3, 0, 7); actx.fill();
        continue;
      }
      const len = 7 + 15 * Math.min(kn / 2.2, 1);
      const ux = c.u / mag, uy = -c.v / mag; // screen y is south
      const a = 0.22 + 0.5 * Math.min(kn / 2.2, 1);
      actx.strokeStyle = `rgba(79,195,232,${a})`;
      actx.fillStyle = actx.strokeStyle;
      actx.lineWidth = 1.4;
      actx.beginPath();
      actx.moveTo(px - ux * len / 2, py - uy * len / 2);
      actx.lineTo(px + ux * len / 2, py + uy * len / 2);
      actx.stroke();
      const hx = px + ux * len / 2, hy = py + uy * len / 2;
      actx.beginPath();
      actx.moveTo(hx, hy);
      actx.lineTo(hx - ux * 4 - uy * 2.4, hy - uy * 4 + ux * 2.4);
      actx.lineTo(hx - ux * 4 + uy * 2.4, hy - uy * 4 - ux * 2.4);
      actx.closePath(); actx.fill();
    }
  }
}
map.on('move zoom resize viewreset', drawArrows);

// ---- path layers ----
const layers = {
  ghost: L.polyline([], { color: '#8fa3c4', weight: 1.5, opacity: 0.55, dashArray: '5 6', interactive: false }).addTo(map),
  full: L.polyline([], { color: '#ff6b4a', weight: 1.5, opacity: 0.3, interactive: false }).addTo(map),
  trail: L.polyline([], { color: '#ff6b4a', weight: 2.5, opacity: 0.95, interactive: false }).addTo(map),
  ticks: L.layerGroup().addTo(map),
  swimmer: L.circleMarker([51.1, 1.3], {
    radius: 6, color: '#0a1220', weight: 2, fillColor: '#ff6b4a', fillOpacity: 1, interactive: false,
  }).addTo(map),
  start: null, land: null,
};

function setMarker(key, latlng, cls, html) {
  if (layers[key]) map.removeLayer(layers[key]);
  layers[key] = latlng ? L.marker(latlng, {
    icon: L.divIcon({ className: '', html: `<div class="${cls}">${html}</div>`, iconSize: null }),
    interactive: false,
  }).addTo(map) : null;
}

// ---- interpolate position along a result path ----
function posAt(path, t) {
  if (t <= 0) return path[0];
  const last = path[path.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = path.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (path[m].t <= t ? lo = m : hi = m); }
  const a = path[lo], b = path[hi], f = (t - a.t) / (b.t - a.t || 1);
  return { t, lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

// ---- recompute (optimizer) ----
let computeTimer = null;
function requestCompute() {
  $('status').textContent = 'computing tracks…';
  $('status').classList.add('busy');
  clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, 180);
}

// pick the real departure instant for a HW-relative start time: prefer a
// start on the chosen date, as close to 03:00 as possible (night start,
// daylight landing — standard pilot practice)
function clockFor(t0) {
  const a = state.astro;
  let best = null;
  for (const hw of a.hws) {
    const s = hw + t0 * 3600e3;
    const inDay = s >= a.dayStart && s < a.dayStart + 86400e3;
    const key = (inDay ? 0 : 1e15) + Math.abs(s - (a.dayStart + 3 * 3600e3));
    if (!best || key < best.key) best = { key, s };
  }
  return best.s;
}

function applyDate() {
  if (!state.useDate) { state.astro = null; return; }
  const dayStart = Date.parse(state.dateStr + 'T00:00:00');
  const noon = dayStart + 12 * 3600e3;
  state.astro = {
    dayStart,
    hws: ASTRO.hwTimes(dayStart),
    sun: ASTRO.sun(dayStart),
    moon: ASTRO.moonInfo(noon),
  };
  state.spring = ASTRO.springFactor(noon);
  const sf = $('springf');
  sf.value = state.spring;
  $('springlabel').textContent =
    (state.spring < 0.75 ? 'neaps' : state.spring > 1.1 ? 'big springs' : state.spring > 0.95 ? 'springs' : 'mid-cycle') + ' · from date';
  const m = state.astro.moon;
  $('mooninfo').textContent = `${m.emoji} ${m.name}`;
  const dayHW = state.astro.hws.filter(h => h >= dayStart && h < dayStart + 86400e3);
  const s = state.astro.sun;
  const fh = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`;
  const month = new Date(dayStart).getMonth() + 1;
  $('datehint').textContent =
    `HW Dover ≈ ${dayHW.map(fmtClock).join(' / ')} · sunrise ${fh(s.rise)} · sunset ${fh(s.set)}` +
    (month >= 6 && month <= 9 ? '' : ' · outside the usual Jun–Sep season');
}

function compute() {
  applyDate();
  const start = SIM.START_POINTS[state.startKey];
  const cfg = { startLL: start, speedMs: state.speedKmh / 3.6, spring: state.spring };
  state.results = SIM.optimize(cfg, state.manualStart ? state.t0Manual : null);
  const R = state.results;
  const pick = {
    optimal: { result: R.optimal.result, t0: R.optimal.t0, headingFn: SIM.legHeading(R.optimal.legsDeg), label: 'Optimised track' },
    constant: { result: R.constant.result, t0: R.constant.t0, headingFn: SIM.constHeading(R.constant.headingDeg), label: `Constant heading ${Math.round(R.constant.headingDeg)}°` },
    aim: { result: R.aim.result, t0: R.aim.t0, headingFn: SIM.aimAtCape(), label: 'Aim at Cap Gris-Nez' },
  };
  state.view = pick[state.strategy];
  state.ghost = state.strategy === 'aim' ? pick.optimal : pick.aim;
  state.simT = 0;
  state.playing = false;
  $('play').textContent = '▶';
  renderAll();
  $('status').textContent = 'ready';
  $('status').classList.remove('busy');
}

// ---- render everything for the current view ----
function renderAll() {
  const v = state.view, r = v.result;
  const start = SIM.START_POINTS[state.startKey];

  layers.full.setLatLngs(r.path.map(p => [p.lat, p.lng]));
  layers.ghost.setLatLngs(state.ghost.result.path.map(p => [p.lat, p.lng]));
  layers.ticks.clearLayers();
  for (let h = 1; h < r.hours; h++) {
    const p = posAt(r.path, h);
    L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: '', html: `<div class="hourfix"><span>×</span><i>${h}h</i></div>`, iconSize: null }),
      interactive: false,
    }).addTo(layers.ticks);
  }
  setMarker('start', [start.lat, start.lng], 'pin pin-start', 'START');
  setMarker('land', r.landed ? [r.landLL.lat, r.landLL.lng] : null, 'pin pin-land',
    r.landedAtCape ? 'GRIS-NEZ' : 'LAND');

  // headline stats
  $('eta').textContent = r.landed ? fmtH(r.hours) : 'no landfall';
  $('eta').classList.toggle('dnf', !r.landed);
  $('viewlabel').textContent = v.label;
  if (state.useDate && state.astro) {
    v.clockStart = clockFor(v.t0);
    $('startTime').textContent = `${fmtClock(v.clockStart)} · ${fmtHW(v.t0)}`;
    if (r.landed) {
      const arr = v.clockStart + r.hours * 3600e3;
      const nextDay = new Date(arr).getDate() !== new Date(v.clockStart).getDate();
      $('arrive').textContent = fmtClock(arr) + (nextDay ? ' +1d' : '');
      const ah = new Date(arr).getHours() + new Date(arr).getMinutes() / 60;
      const s = state.astro.sun;
      $('daylight').textContent = ah >= s.rise && ah <= s.set ? '☀ daylight' : '☾ darkness';
    } else {
      $('arrive').textContent = '–';
      $('daylight').textContent = '–';
    }
  } else {
    v.clockStart = null;
    $('startTime').textContent = fmtHW(v.t0);
    $('arrive').textContent = '–';
    $('daylight').textContent = '–';
  }
  $('ground').textContent = r.distGround.toFixed(1) + ' km';
  $('water').textContent = r.distWater.toFixed(1) + ' km';
  $('landing').textContent = r.landed
    ? (r.landedAtCape ? 'Cap Gris-Nez' : `${r.landLL.lat.toFixed(3)}°N ${r.landLL.lng.toFixed(3)}°E`)
    : 'swept past — swim faster or retime';
  const g = state.ghost.result;
  if (r.landed && g.landed) {
    const d = g.hours - r.hours;
    $('delta').textContent = state.strategy === 'aim'
      ? `${fmtH(Math.abs(d))} slower than the optimised track`
      : `saves ${fmtH(Math.abs(d))} vs aiming at the cape`;
  } else $('delta').textContent = '';

  // benchmark
  if (r.landed) {
    let below = 0, total = 0;
    REAL.bins.forEach((n, i) => {
      total += n;
      const lo = REAL.binStart + i, hi = lo + 1;
      if (hi <= r.hours) below += n;
      else if (lo < r.hours) below += n * (r.hours - lo);
    });
    const pct = 100 * (1 - below / total);
    $('bench').textContent = pct > 99
      ? 'slower than nearly all recorded solos'
      : `faster than ${(100 - pct).toFixed(0)}% of ${REAL.count.toLocaleString('en-GB')} recorded solos`;
  } else $('bench').textContent = '';

  drawHistogram(r.landed ? r.hours : null);
  drawTideStrip();
  updatePlayback(0);
  $('scrub').value = 0;
}

// ---- playback ----
function updatePlayback(t) {
  const v = state.view, r = v.result;
  state.simT = Math.max(0, Math.min(t, r.hours));
  const p = posAt(r.path, state.simT);
  layers.swimmer.setLatLng([p.lat, p.lng]);
  const trail = r.path.filter(q => q.t <= state.simT).map(q => [q.lat, q.lng]);
  trail.push([p.lat, p.lng]);
  layers.trail.setLatLngs(trail);

  // instruments
  $('clock').textContent = fmtH(state.simT);
  $('clock2').textContent = fmtH(state.simT);
  $('tidephase').textContent = fmtHW(v.t0 + state.simT);
  const xy = SIM.toXY(p.lat, p.lng);
  const c = SIM.current(xy, v.t0 + state.simT, state.spring);
  const kn = Math.hypot(c.u, c.v) / SIM.KN;
  const setDir = (Math.atan2(c.u, c.v) * 180 / Math.PI + 360) % 360;
  $('current').textContent = `${kn.toFixed(1)} kn`;
  $('setarrow').style.transform = `rotate(${setDir}deg)`;
  const hdg = (v.headingFn(state.simT, xy) * 180 / Math.PI + 360) % 360;
  $('heading').textContent = `${Math.round(hdg)}°`;
  const fr = SIM.nearestSeg(SIM.FRA_XY, xy);
  $('togo').textContent = `${Math.max(0, fr.d).toFixed(1)} km`;
  // speed over ground from local path slope
  const p2 = posAt(r.path, Math.min(state.simT + 0.1, r.hours));
  const a = SIM.toXY(p.lat, p.lng), b = SIM.toXY(p2.lat, p2.lng);
  const dt = p2.t - p.t;
  $('sog').textContent = dt > 0 ? (Math.hypot(b.x - a.x, b.y - a.y) / dt).toFixed(1) + ' km/h' : '–';

  drawArrows();
  drawTideStrip();
  $('scrub').value = r.hours ? state.simT / r.hours : 0;
}

let lastFrame = null;
function frame(ts) {
  if (!state.playing) { lastFrame = null; return; }
  if (lastFrame != null) {
    // clamp so a hidden/throttled tab doesn't jump on resume
    const dtH = Math.min(ts - lastFrame, 100) / 1000 * state.playSpeed / 3600;
    const t = state.simT + dtH;
    updatePlayback(t);
    if (t >= state.view.result.hours) {
      state.playing = false;
      $('play').textContent = '▶';
    }
  }
  lastFrame = ts;
  if (state.playing) requestAnimationFrame(frame);
}

// ---- histogram (real solo durations) ----
function drawHistogram(simHours) {
  const svg = $('hist');
  const W = svg.clientWidth || 320, H = 104;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const padL = 6, padR = 6, padB = 18, padT = 12;
  const n = REAL.bins.length;
  const bw = (W - padL - padR) / n;
  const max = Math.max(...REAL.bins);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  let s = '';
  REAL.bins.forEach((v, i) => {
    const x = padL + i * bw;
    const h = H - padB - y(v);
    s += `<rect x="${(x + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" rx="2" fill="var(--hist)"><title>${REAL.binStart + i}–${REAL.binStart + i + 1} h: ${v} swims</title></rect>`;
  });
  s += `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--grid)" stroke-width="1"/>`;
  [8, 12, 16, 20].forEach(hr => {
    const x = padL + (hr - REAL.binStart) * bw;
    s += `<text x="${x}" y="${H - 5}" fill="var(--muted)" font-size="9" text-anchor="middle" font-family="IBM Plex Mono, monospace">${hr}h</text>`;
  });
  const mx = padL + (REAL.median - REAL.binStart) * bw;
  s += `<line x1="${mx}" y1="${padT - 2}" x2="${mx}" y2="${H - padB}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3"/>`;
  if (simHours != null && simHours < REAL.binStart + n + 1) {
    const sx = padL + Math.min(Math.max(simHours - REAL.binStart, 0), n) * bw;
    s += `<line x1="${sx}" y1="${padT - 6}" x2="${sx}" y2="${H - padB}" stroke="var(--accent)" stroke-width="2"/>`;
    const anchor = sx > W - 50 ? 'end' : 'start';
    s += `<text x="${sx + (anchor === 'end' ? -4 : 4)}" y="${padT + 2}" fill="var(--accent)" font-size="9.5" text-anchor="${anchor}" font-family="IBM Plex Mono, monospace">you</text>`;
  }
  svg.innerHTML = s;
}

// ---- tide strip ----
function tideWindow() {
  const t0 = state.view ? state.view.t0 : 0;
  return { from: t0 - 2, to: t0 + Math.max(16, (state.view ? state.view.result.hours : 12) + 3) };
}
function drawTideStrip() {
  const cv = $('tide');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const { from, to } = tideWindow();
  const peak = 1.9 * state.spring * 1.15;
  const X = (t) => (t - from) / (to - from) * W;
  const Y = (kn) => H / 2 - (kn / peak) * (H / 2 - 12);
  const v = state.view;

  // night shading (only when coupled to a calendar date)
  const clockOf = (v && v.clockStart != null)
    ? (t) => v.clockStart + (t - v.t0) * 3600e3
    : null;
  if (clockOf) {
    const s = state.astro.sun;
    ctx.fillStyle = 'rgba(4,8,16,0.5)';
    for (let px = 0; px < W; px += 2) {
      const t = from + (to - from) * px / W;
      const d = new Date(clockOf(t));
      const h = d.getHours() + d.getMinutes() / 60;
      if (h < s.rise || h > s.set) ctx.fillRect(px, 8, 2, H - 24);
    }
  }
  // swim interval
  if (v && v.result.landed !== undefined) {
    ctx.fillStyle = 'rgba(255,107,74,0.10)';
    ctx.fillRect(X(v.t0), 8, X(v.t0 + v.result.hours) - X(v.t0), H - 24);
  }
  // zero line + HW ticks
  ctx.strokeStyle = 'rgba(143,163,196,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  ctx.fillStyle = 'rgba(143,163,196,0.9)';
  ctx.font = '9px IBM Plex Mono, monospace';
  ctx.textAlign = 'center';
  const firstHW = Math.ceil(from / SIM.T_M2) * SIM.T_M2;
  for (let t = firstHW; t < to; t += SIM.T_M2) {
    ctx.strokeStyle = 'rgba(143,163,196,0.25)';
    ctx.beginPath(); ctx.moveTo(X(t), 8); ctx.lineTo(X(t), H - 16); ctx.stroke();
    ctx.fillText('HW', X(t), clockOf ? 16 : H - 4);
  }
  // wall-clock axis labels every 6 h when coupled to a date
  if (clockOf) {
    const msFrom = clockOf(from), msTo = clockOf(to);
    let tick = Math.ceil(msFrom / (6 * 3600e3)) * 6 * 3600e3;
    for (; tick < msTo; tick += 6 * 3600e3) {
      const t = from + (tick - msFrom) / 3600e3;
      ctx.fillText(fmtClock(tick), X(t), H - 4);
    }
  }
  // labels
  ctx.textAlign = 'left';
  ctx.fillText('NE →', 4, 12);
  ctx.fillText('← SW', 4, H - 6);
  // curve: mid-strait stream in knots
  ctx.strokeStyle = '#4fc3e8';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let px = 0; px <= W; px += 2) {
    const t = from + (to - from) * px / W;
    const kn = 1.9 * state.spring * SIM.tideSignal(t);
    px === 0 ? ctx.moveTo(px, Y(kn)) : ctx.lineTo(px, Y(kn));
  }
  ctx.stroke();
  // time cursor
  if (v) {
    ctx.strokeStyle = '#ff6b4a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X(v.t0 + state.simT), 8);
    ctx.lineTo(X(v.t0 + state.simT), H - 16);
    ctx.stroke();
  }
}

// ---- controls wiring ----
function bind() {
  const speed = $('speed');
  speed.addEventListener('input', () => {
    state.speedKmh = +speed.value;
    updateSpeedLabel();
    requestCompute();
  });
  const dateEl = $('startdate');
  dateEl.value = state.dateStr;
  dateEl.addEventListener('change', () => {
    if (dateEl.value) { state.dateStr = dateEl.value; requestCompute(); }
  });
  const useDate = $('usedate');
  useDate.checked = state.useDate;
  $('springf').disabled = state.useDate;
  useDate.addEventListener('change', () => {
    state.useDate = useDate.checked;
    $('springf').disabled = state.useDate;
    if (!state.useDate) {
      $('mooninfo').textContent = '';
      $('datehint').textContent = '';
      state.spring = +$('springf').value;
      $('springlabel').textContent =
        state.spring < 0.75 ? 'neaps' : state.spring > 1.1 ? 'big springs' : state.spring > 0.95 ? 'springs' : 'mid-cycle';
    }
    requestCompute();
  });
  const spring = $('springf');
  spring.addEventListener('input', () => {
    state.spring = +spring.value;
    $('springlabel').textContent =
      state.spring < 0.75 ? 'neaps' : state.spring > 1.1 ? 'big springs' : state.spring > 0.95 ? 'springs' : 'mid-cycle';
    requestCompute();
  });
  $('startpt').addEventListener('change', (e) => { state.startKey = e.target.value; requestCompute(); });
  document.querySelectorAll('input[name=strategy]').forEach(el =>
    el.addEventListener('change', () => { state.strategy = el.value; compute(); }));
  const manual = $('manual');
  const t0s = $('t0slider');
  manual.addEventListener('change', () => {
    state.manualStart = manual.checked;
    t0s.disabled = !manual.checked;
    requestCompute();
  });
  t0s.addEventListener('input', () => {
    state.t0Manual = +t0s.value;
    $('t0label').textContent = fmtHW(state.t0Manual);
    if (state.manualStart) requestCompute();
  });
  $('play').addEventListener('click', () => {
    if (!state.view) return;
    if (!state.playing && state.simT >= state.view.result.hours - 1e-6) state.simT = 0;
    state.playing = !state.playing;
    $('play').textContent = state.playing ? '⏸' : '▶';
    if (state.playing) requestAnimationFrame(frame);
  });
  $('scrub').addEventListener('input', (e) => {
    state.playing = false;
    $('play').textContent = '▶';
    if (state.view) updatePlayback(+e.target.value * state.view.result.hours);
  });
  $('pspeed').addEventListener('change', (e) => { state.playSpeed = +e.target.value; });
  window.addEventListener('resize', () => { drawArrows(); drawTideStrip(); if (state.view) drawHistogram(state.view.result.landed ? state.view.result.hours : null); });
}

function updateSpeedLabel() {
  const v = state.speedKmh;
  const pace = 360 / v; // seconds per 100 m
  $('speedlabel').textContent = `${v.toFixed(1)} km/h`;
  $('pacelabel').textContent = `${(v / 3.6).toFixed(2)} m/s · ${Math.floor(pace / 60)}:${String(Math.round(pace % 60)).padStart(2, '0')} /100m`;
}

// ---- boot ----
bind();
updateSpeedLabel();
$('t0label').textContent = fmtHW(state.t0Manual);
drawArrows();
compute();
