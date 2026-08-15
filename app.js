/* UI layer: Leaflet map, animated tide field, controls, instruments, benchmark. */
'use strict';

// ---- reference data extracted from the CS&PF/CSA public solo database ----
const REAL = {
  count: 3074, fastest: 6.76, median: 13.35, p10: 10.31, p90: 16.82, gnPct: 31.8,
  // 1-h bins of E->F solo durations, first bin = 6-7 h
  bins: [3, 15, 63, 161, 275, 399, 457, 473, 412, 319, 209, 127, 61, 40, 28, 13, 12, 7],
  binStart: 6,
};

// All clock times are Dover local (GMT/BST) regardless of the viewer's zone —
// the HW model works in real UTC instants, so this has to be explicit.
const UK = 'Europe/London';
const ukParts = (ms) => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: UK, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return p;
};
const ukOffset = (ms) => {                       // ms to add to UTC to get UK time
  const p = ukParts(ms);
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
};
// instant of 00:00 UK time on a YYYY-MM-DD date
const ukMidnight = (dateStr) => {
  const guess = Date.parse(dateStr + 'T00:00:00Z');
  return guess - ukOffset(guess - ukOffset(guess));
};

// ---- calendar astronomy: HW Dover, tidal range, moon phase, sun ----
const ASTRO = (() => {
  const SYN = 29.530588853;                       // synodic month, days
  const D2R = Math.PI / 180;
  const sind = (x) => Math.sin(x * D2R);

  // --- HW Dover: semidiurnal harmonic model ---------------------------------
  // eta(t) = Z0 + Re{ Z(t) * e^{i*wM2*t} },  Z(t) = sum_i c_i e^{i(w_i - wM2)t},
  // so high water is where  wM2*t + arg Z(t) = 0 (mod 2pi)  and the tidal
  // amplitude is |Z(t)|. t = hours UTC since TIDE_EPOCH.
  //
  // The c_i were fitted by complex least squares to 56 published Dover high
  // waters (2026-08-15..2026-09-12). They are a *timing* fit, not Admiralty
  // harmonic constants — Z0 and the shallow-water distortion of Dover's curve
  // are absorbed into them, so the amplitudes are not the real M2/S2/N2 ones.
  // Only M2, S2 and N2 are carried: over a 29-day record K2 cannot be separated
  // from S2 nor L2 from M2 (Rayleigh criterion), and a holdout test showed that
  // adding them overfits badly (out-of-sample RMS 16 -> 98 min with L2).
  // Accuracy: 11.6 min RMS in-sample, ~16 min RMS / 23 min max out-of-sample.
  // Nodal (18.6 y) modulation is not modelled, so accuracy decays slowly over
  // years, and the fit is anchored on the Aug/Sep swim season.
  const TIDE_EPOCH = Date.UTC(2026, 0, 1);
  const W_M2 = 28.9841042 * D2R;                  // deg/h -> rad/h
  const PARTS = [                                 // [speed-wM2 (rad/h), c.re, c.im]
    [(28.9841042 - 28.9841042) * D2R, -0.567310, 1.642265],   // M2
    [(30.0000000 - 28.9841042) * D2R, 0.805192, -0.170592],   // S2
    [(28.4397295 - 28.9841042) * D2R, -0.239403, 0.259680],   // N2
  ];
  const hoursOf = (ms) => (ms - TIDE_EPOCH) / 3600e3;

  function envelope(t) {
    let re = 0, im = 0;
    for (const [dw, cr, ci] of PARTS) {
      const th = dw * t, ct = Math.cos(th), st = Math.sin(th);
      re += cr * ct - ci * st;
      im += cr * st + ci * ct;
    }
    return { mag: Math.hypot(re, im), arg: Math.atan2(im, re) };
  }

  // instant (ms) of the high water nearest to `ms`
  function hwNear(ms) {
    let t = hoursOf(ms);
    for (let k = 0; k < 25; k++) {
      let ph = W_M2 * t + envelope(t).arg;
      ph = ((ph + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      t -= ph / W_M2;
      if (Math.abs(ph) < 1e-11) break;
    }
    return TIDE_EPOCH + t * 3600e3;
  }

  // HW Dover instants (ms) spanning the day around `dayStartMs`
  function hwTimes(dayStartMs) {
    const first = hwNear(dayStartMs + 12 * 3600e3);
    const out = [];
    for (let k = -4; k <= 4; k++) {
      const h = hwNear(first + k * SIM.T_M2 * 3600e3);
      if (!out.some((o) => Math.abs(o - h) < 3600e3)) out.push(h);
    }
    return out.sort((a, b) => a - b);
  }

  // --- tidal range -> stream strength ---------------------------------------
  // Tidal stream rates scale with the tidal range (standard Admiralty
  // interpolation). |Z| -> range fitted on the same 56 HW/LW pairs
  // (RMS 0.19 m); MEAN_SPRING_RANGE is the largest range in that record, so the
  // factor is 1.0 at mean springs and ~0.41 at mean neaps — which is what the
  // sim's `spring` multiplier expects (1.0 = mean-spring peak rates).
  const RANGE_A = 1.4104, RANGE_B = 1.7609, MEAN_SPRING_RANGE = 6.16;
  const rangeAt = (ms) => RANGE_A + RANGE_B * envelope(hoursOf(hwNear(ms))).mag;
  function springFactor(ms) {
    return Math.max(0.35, Math.min(1.15, rangeAt(ms) / MEAN_SPRING_RANGE));
  }

  // --- moon phase (display only) --------------------------------------------
  // Moon-Sun elongation from Schlyter's low-precision lunar series; reproduces
  // the 2026 new/full moons to within ~10 min (the old mean-synodic formula was
  // out by up to 15 h, enough to mislabel the phase).
  function elongation(ms) {
    const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const Ms = 357.5291 + 0.98560028 * d;
    const Ls = 280.4665 + 0.98564736 * d;
    const sunLon = Ls + 1.9147 * sind(Ms) + 0.0200 * sind(2 * Ms) + 0.0003 * sind(3 * Ms);
    const Lm = 218.3164 + 13.17639648 * d;
    const Mm = 134.9634 + 13.06499295 * d;
    const De = 297.8502 + 12.19074912 * d;
    const F = 93.2721 + 13.22935024 * d;
    const moonLon = Lm
      + 6.289 * sind(Mm) - 1.274 * sind(Mm - 2 * De) + 0.658 * sind(2 * De)
      + 0.214 * sind(2 * Mm) - 0.186 * sind(Ms) - 0.114 * sind(2 * F)
      - 0.059 * sind(2 * Mm - 2 * De) - 0.057 * sind(Mm - 2 * De + Ms)
      + 0.053 * sind(Mm + 2 * De) + 0.046 * sind(2 * De - Ms) + 0.041 * sind(Mm - Ms)
      - 0.035 * sind(De) - 0.031 * sind(Mm + Ms) - 0.015 * sind(2 * F - 2 * De)
      + 0.011 * sind(Mm - 4 * De);
    return ((moonLon - sunLon) % 360 + 360) % 360;
  }
  const ageAt = (ms) => elongation(ms) / 360 * SYN;

  function moonInfo(ms) {
    const e = elongation(ms);
    const names = ['new moon', 'waxing crescent', 'first quarter', 'waxing gibbous',
      'full moon', 'waning gibbous', 'last quarter', 'waning crescent'];
    const emo = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    const i = Math.round(e / 45) % 8;
    return { age: ageAt(ms), name: names[i], emoji: emo[i] };
  }
  // --- expected sea temperature --------------------------------------------
  // NASA JPL MUR SST v4.1 (1 km, L4) monthly composites, area-averaged over the
  // route box 50.85–51.15 N / 1.30–1.95 E, 2015–2026 (see the ERDDAP script and
  // kanal_sst_monatsmittel.csv). Per month: [expected, min, max] in °C.
  // "Expected" is the mean of the five most recent years, not the median of all
  // twelve: the record carries a clear warming trend (~+1.0 °C/decade over
  // Jun–Sep), so an all-year median would sit ~0.5 °C low for a swim today. The
  // min/max are the full observed spread and are what the uncertainty is.
  const SST = [
    [9.27, 7.6, 10.5], [8.58, 7.4, 9.2], [8.84, 6.6, 9.6], [10.10, 8.1, 10.7],
    [12.51, 10.3, 13.0], [15.12, 14.1, 15.8], [17.90, 16.2, 19.2],
    [18.72, 17.5, 19.8], [18.44, 17.1, 19.1], [16.48, 15.2, 17.3],
    [14.13, 13.0, 15.1], [11.06, 10.0, 12.2],
  ];
  const DIM = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Catmull-Rom through the twelve monthly values, which sit at mid-month, so
  // the curve is smooth across month boundaries instead of stepping.
  function seaTemp(ms) {
    const p = ukParts(ms);
    const mi = +p.month - 1;
    const f = mi + (+p.day - 0.5) / DIM[mi] - 0.5;   // sample i sits at f = i
    const i = Math.floor(f), u = f - i;
    const at = (k, j) => SST[((k % 12) + 12) % 12][j];
    const spline = (j) => {
      const a = at(i - 1, j), b = at(i, j), c = at(i + 1, j), d = at(i + 2, j);
      return 0.5 * ((2 * b) + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u
        + (-a + 3 * b - 3 * c + d) * u * u * u);
    };
    return { c: spline(0), lo: spline(1), hi: spline(2) };
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
  return { ageAt, springFactor, rangeAt, moonInfo, hwTimes, hwNear, seaTemp, sun };
})();

// label for a stream-strength multiplier (1.0 = mean springs, ~0.41 = mean neaps)
const rangeLabel = (f) =>
  f < 0.55 ? 'neaps' : f < 0.75 ? 'towards neaps' : f < 0.92 ? 'mid-cycle'
    : f < 1.02 ? 'springs' : 'big springs';

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
  const p = ukParts(ms);
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
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
  const dayStart = ukMidnight(state.dateStr);
  const noon = dayStart + 12 * 3600e3;
  state.astro = {
    dayStart,
    hws: ASTRO.hwTimes(dayStart),
    sun: ASTRO.sun(dayStart),
    moon: ASTRO.moonInfo(noon),
    sea: ASTRO.seaTemp(noon),
  };
  state.spring = ASTRO.springFactor(noon);
  const sf = $('springf');
  sf.value = state.spring;
  $('springlabel').textContent = rangeLabel(state.spring) + ' · from date';
  const m = state.astro.moon;
  $('mooninfo').textContent = `${m.emoji} ${m.name}`;
  const dayHW = state.astro.hws.filter(h => h >= dayStart && h < dayStart + 86400e3);
  const s = state.astro.sun;
  const fh = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`;
  const month = +ukParts(dayStart + 12 * 3600e3).month;
  const t = state.astro.sea;
  $('datehint').textContent =
    `HW Dover ≈ ${dayHW.map(fmtClock).join(' / ')} · sunrise ${fh(s.rise)} · sunset ${fh(s.set)}` +
    (month >= 6 && month <= 9 ? '' : ' · outside the usual Jun–Sep season');
  $('seatemp').textContent = `${t.c.toFixed(1)} °C`;
  $('seahint').textContent =
    `sea surface, route average · 2015–2026 spread ${t.lo.toFixed(1)}–${t.hi.toFixed(1)} °C · ` +
    (t.c < 14 ? 'cold even by Channel standards'
      : t.c < 16 ? 'cool — early- or late-season water'
        : 'typical for the Jun–Sep window');
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
      $('seatemp').textContent = '–';
      $('seahint').textContent = 'pick a date to get the expected water temperature';
      state.spring = +$('springf').value;
      $('springlabel').textContent = rangeLabel(state.spring);
    }
    requestCompute();
  });
  const spring = $('springf');
  spring.addEventListener('input', () => {
    state.spring = +spring.value;
    $('springlabel').textContent = rangeLabel(state.spring);
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
