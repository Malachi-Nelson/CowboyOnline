// The ground and the water of Calder Territory, made from a seed.
//
// Heights sit on a 4 m lattice and are read bilinearly, so the browser's mesh and the server's physics agree
// exactly. Only + - * / and Math.sqrt are used to make them, which keeps every JavaScript engine in step
// (Math.sin and friends may differ in the last bit between engines).
//
// The map is 4 km square. North is -z, east is +x.
//   centre      Calder's Landing, on the west bank of the Calder river
//   north-west  the Sawback range, forest on its lower slopes
//   far north   snowy high country, where the river rises in a lake
//   south-west  desert: a raised floor, buttes, and a dry canyon
//   south-east  the Mirewood, at water level
//   the rest    rolling plains
import { WORLD_SIZE, HUB_X, HUB_Z } from '../constants.js';

export const LAT = 4;
export const LAT_N = WORLD_SIZE / LAT + 1;
export const MASK_N = (LAT_N + 1) >> 1;          // region masks are kept on every second lattice point
export const SWAMP_LEVEL = 12;
export const NO_WATER = -100;

// Where things are. Towns are flattened pads; `ax`..`bx` stretches a pad along its main street.
export const PLACES = [
  { id: 'hub', name: "Calder's Landing", kind: 'town', x: HUB_X, z: HUB_Z, r: 150, ax: 1880, bx: 2250 },
  { id: 'timber', name: 'Timber Halt', kind: 'camp', x: 1330, z: 1470, r: 70 },
  { id: 'lantern', name: 'Cold Lantern Camp', kind: 'camp', x: 2300, z: 430, r: 55 },
  { id: 'mirewood', name: 'Mirewood', kind: 'camp', x: 2980, z: 2900, r: 65 },
  { id: 'dryfork', name: 'Dry Fork', kind: 'town', x: 900, z: 3080, r: 85 },
  { id: 'ranch', name: 'Tolliver Ranch', kind: 'ranch', x: 2950, z: 1750, r: 75 },
];
const RIVER = [[1750, 690], [1790, 980], [1900, 1270], [2020, 1590], [2125, 1880], [2150, 2060], [2190, 2330], [2400, 2620], [2690, 2890], [3000, 3140], [3400, 3480], [4100, 3860]];
const CANYON = [[330, 2760], [560, 3020], [640, 3330], [900, 3560], [1230, 3700], [1400, 3770]];
export const ROADS = [
  { id: 'main', to: 'hub', pts: [[1880, HUB_Z], [2000, HUB_Z], [2110, HUB_Z]] },
  { id: 'timber', to: 'timber', pts: [[1880, HUB_Z], [1700, 1900], [1520, 1700], [1400, 1560], [1330, 1470]] },
  { id: 'north', to: 'lantern', pts: [[2192, HUB_Z], [2260, 1850], [2330, 1500], [2400, 1100], [2380, 750], [2300, 430]] },
  { id: 'east', to: 'ranch', pts: [[2192, HUB_Z], [2480, 1990], [2760, 1860], [2950, 1750]] },
  { id: 'mire', to: 'mirewood', pts: [[2192, HUB_Z], [2300, 2200], [2420, 2400], [2620, 2620], [2860, 2800], [2980, 2900]] },
  { id: 'dry', to: 'dryfork', pts: [[1880, HUB_Z], [1690, 2290], [1400, 2640], [1100, 2930], [900, 3080]] },
];

const sat = v => (v < 0 ? 0 : v > 1 ? 1 : v);
// smoothstep from a to b; a may be the larger, for a falling edge
export const ss = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
export function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 > 0 ? sat(((px - ax) * dx + (pz - az) * dz) / l2) : 0, qx = ax + dx * t - px, qz = az + dz * t - pz;
  return Math.sqrt(qx * qx + qz * qz);
}
function bilinear(A, n, fx, fz) {
  const m = n - 1.0001;
  if (fx < 0) fx = 0; else if (fx > m) fx = m;
  if (fz < 0) fz = 0; else if (fz > m) fz = m;
  const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, o = j * n + i, a = A[o], b = A[o + 1], c = A[o + n], d = A[o + n + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

// A smooth curve through control points (Catmull-Rom), as samples about `step` metres apart.
// Returns { x, z, cum (distance along), n, at (the sample index of each control point) }.
export function spline(ctrl, step) {
  const xs = [], zs = [], at = [], P = i => ctrl[i < 0 ? 0 : i >= ctrl.length ? ctrl.length - 1 : i];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), dx = p2[0] - p1[0], dz = p2[1] - p1[1], n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dz * dz) / step));
    at.push(xs.length);
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      xs.push(0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3));
      zs.push(0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3));
    }
  }
  at.push(xs.length); xs.push(ctrl[ctrl.length - 1][0]); zs.push(ctrl[ctrl.length - 1][1]);
  const n = xs.length, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) { const dx = xs[i] - xs[i - 1], dz = zs[i] - zs[i - 1]; cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz); }
  return { x: Float64Array.from(xs), z: Float64Array.from(zs), cum, n, at };
}
function smooth(a, r) {
  const n = a.length, b = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { s += a[k]; c++; } b[i] = s / c; }
  a.set(b);
}

// How much of each kind of country a spot is, 0..1 each. The edges are bent by slow noise so no border is a line.
export function regionAt(x, z, seed, o) {
  const xw = x + (vnoise(x / 900, z / 900, seed + 1) - 0.5) * 520, zw = z + (vnoise(x / 900, z / 900, seed + 2) - 0.5) * 520;
  const dr = distSeg(xw, zw, 200, 2050, 1450, 380);
  o.north = ss(1300, 520, zw);
  o.mount = ss(820, 120, dr);
  o.forest = ss(1320, 760, dr);
  let dx = xw - 760, dz = zw - 3420; o.desert = ss(1450, 800, Math.sqrt(dx * dx + dz * dz));
  dx = xw - 3420; dz = zw - 3420; o.swamp = ss(1050, 600, Math.sqrt(dx * dx + dz * dz));
  return o;
}

// The land before anything is built or cut into it. dRiv: distance to the river's course.
function natural(x, z, sd, m, dRiv) {
  const flood = 0.3 + 0.7 * ss(40, 420, dRiv), valley = ss(90, 640, dRiv);
  const tilt = 26 - (x + z) * (40 / 8192);                                   // the whole territory falls away to the south-east
  const roll = ((vnoise(x / 640, z / 640, sd + 3) - 0.5) * 22 + (vnoise(x / 210, z / 210, sd + 4) - 0.5) * 9) * flood;
  let h = 34 + tilt + roll + (vnoise(x / 60, z / 60, sd + 5) - 0.5) * 2.2 + (vnoise(x / 19, z / 19, sd + 6) - 0.5) * 0.5;
  if (m.desert > 0) {
    const b = vnoise(x / 310, z / 310, sd + 12);
    h += m.desert * (16 - roll * 0.6) + ss(0.35, 0.8, m.desert) * (ss(0.6, 0.66, b) * 42 + ss(0.74, 0.78, b) * 26);
  }
  if (m.mount > 0) {
    const r1 = 1 - 2 * Math.abs(vnoise(x / 380, z / 380, sd + 7) - 0.5), r2 = 1 - 2 * Math.abs(vnoise(x / 150, z / 150, sd + 8) - 0.5), k = m.mount * m.mount * (3 - 2 * m.mount);
    h += (k * (95 + 150 * r1 * r1 + 40 * r2) + m.mount * (vnoise(x / 90, z / 90, sd + 9) - 0.5) * 14) * (0.1 + 0.9 * valley);
  }
  if (m.north > 0) {
    const r1 = 1 - 2 * Math.abs(vnoise(x / 520, z / 520, sd + 10) - 0.5);
    h += (m.north * (62 + (vnoise(x / 700, z / 700, sd + 11) - 0.5) * 40) + m.north * m.north * r1 * r1 * 85) * (0.2 + 0.8 * valley);
  }
  if (m.swamp > 0) h += (11.9 + (vnoise(x / 64, z / 64, sd + 13) - 0.5) * 2.7 + (vnoise(x / 18, z / 18, sd + 14) - 0.5) * 0.7 - h) * m.swamp;
  // hills round the rim, so the edge of the map is a ridge and not a drop; the Mirewood runs out to open water
  const e = Math.min(x, z, WORLD_SIZE - x, WORLD_SIZE - z);
  if (e < 200) { const k = ss(200, 20, e); h += k * k * 85 * (1 - m.swamp); }
  return h;
}

export function makeTerrain(seed) {
  const N = LAT_N, sd = seed | 0;
  const H = new Float32Array(N * N), W = new Float32Array(N * N), wet = new Uint8Array(N * N), road = new Uint8Array(N * N), masks = new Uint8Array(MASK_N * MASK_N * 5);
  const hAt = (x, z) => bilinear(H, N, x / LAT, z / LAT);

  // ---- the river's course, and a coarse map of how far everything is from it
  const river = spline(RIVER, 8), CN = 257, RD = new Float32Array(CN * CN);
  {
    const k = []; for (let i = 0; i < river.n; i += 8) k.push(i); if (k[k.length - 1] !== river.n - 1) k.push(river.n - 1);
    for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) {
      let best = 1e9; const px = i * 16, pz = j * 16;
      for (let s = 0; s < k.length - 1; s++) { const d = distSeg(px, pz, river.x[k[s]], river.z[k[s]], river.x[k[s + 1]], river.z[k[s + 1]]); if (d < best) best = d; }
      RD[j * CN + i] = best;
    }
  }
  const riverDist = (x, z) => bilinear(RD, CN, x / 16, z / 16);

  // ---- the land as it lay
  const m = { north: 0, mount: 0, forest: 0, desert: 0, swamp: 0 };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = i * LAT, z = j * LAT, o = j * N + i;
    regionAt(x, z, sd, m);
    H[o] = natural(x, z, sd, m, riverDist(x, z));
    W[o] = m.swamp > 0.04 ? SWAMP_LEVEL : NO_WATER;
    if (!(i & 1) && !(j & 1)) { const q = ((j >> 1) * MASK_N + (i >> 1)) * 5; masks[q] = m.north * 255 + 0.5; masks[q + 1] = m.mount * 255 + 0.5; masks[q + 2] = m.forest * 255 + 0.5; masks[q + 3] = m.desert * 255 + 0.5; masks[q + 4] = m.swamp * 255 + 0.5; }
  }
  const maskAt = (x, z, c) => { const i = (x / (LAT * 2) + 0.5) | 0, j = (z / (LAT * 2) + 0.5) | 0; return masks[((j < 0 ? 0 : j >= MASK_N ? MASK_N - 1 : j) * MASK_N + (i < 0 ? 0 : i >= MASK_N ? MASK_N - 1 : i)) * 5 + c] / 255; };

  // ---- the river's level: always below the land it crosses, always falling, level past the town
  const rn = river.n, nat = new Float64Array(rn), wl = new Float64Array(rn), hw = new Float64Array(rn), dp = new Float64Array(rn), reach = new Float64Array(rn);
  for (let i = 0; i < rn; i++) nat[i] = hAt(river.x[i], river.z[i]);
  smooth(nat, 6);
  let iHub = 0; for (let i = 0; i < rn; i++) if (Math.abs(river.z[i] - HUB_Z) < Math.abs(river.z[iHub] - HUB_Z)) iHub = i;
  { const a = Math.max(0, iHub - 30), b = Math.min(rn - 1, iHub + 30); let lo = 1e9; for (let i = a; i <= b; i++) if (nat[i] < lo) lo = nat[i]; for (let i = a; i <= b; i++) nat[i] = lo; }
  let lakeEnd = 0; while (lakeEnd < rn - 1 && river.cum[lakeEnd] < 150) lakeEnd++;
  { let lo = 1e9; for (let i = 0; i <= lakeEnd; i++) if (nat[i] < lo) lo = nat[i]; for (let i = 0; i <= lakeEnd; i++) wl[i] = lo - 2; }
  for (let i = lakeEnd + 1; i < rn; i++) { const v = Math.min(wl[i - 1] - 0.016, nat[i] - 3); wl[i] = v < SWAMP_LEVEL ? SWAMP_LEVEL : v; }
  const ford = river.cum[river.at[2]];
  for (let i = 0; i < rn; i++) {
    const s = river.cum[i], q = s / 150, lake = s < 150 ? 105 * Math.sqrt(1 - q * q) : 0, w = 11 + 15 * ss(0, 1500, s) + 8 * ss(2400, 4200, s);
    hw[i] = w > lake ? w : lake;
    dp[i] = s < 190 ? 4 : 1.5 + 1.1 * ss(300, 1300, s);
    dp[i] += (0.65 - dp[i]) * ss(60, 25, Math.abs(s - ford));                   // a ford: knee deep for forty metres
    reach[i] = hw[i] + 80;
  }
  const hubLevel = Math.fround(wl[iHub] + 2.2);

  // ---- pads for the settlements
  const places = PLACES.map(p => ({ ...p, y: Math.fround(p.id === 'hub' ? hubLevel : p.id === 'mirewood' ? SWAMP_LEVEL + 1.1 : hAt(p.x, p.z)) }));
  for (const p of places) {
    const ax = p.ax || p.x, bx = p.bx || p.x, R = p.r + 80;
    const i0 = Math.max(0, Math.floor((ax - R) / LAT)), i1 = Math.min(N - 1, Math.ceil((bx + R) / LAT)), j0 = Math.max(0, Math.floor((p.z - R) / LAT)), j1 = Math.min(N - 1, Math.ceil((p.z + R) / LAT));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const o = j * N + i, k = ss(p.r + 80, p.r, distSeg(i * LAT, j * LAT, ax, p.z, bx, p.z)); if (k > 0) H[o] += (p.y - H[o]) * k; }
  }

  // ---- cutting things into the land along a path: for every lattice point within reach, the nearest point of the path
  const D = new Float32Array(N * N), SI = new Float32Array(N * N), ID = new Uint8Array(N * N);
  let stampId = 0;
  function stamp(xs, zs, n, R, then) {
    const id = ++stampId; let a0 = N, a1 = 0, b0 = N, b1 = 0;
    for (let s = 0; s < n - 1; s++) {
      const ax = xs[s], az = zs[s], dx = xs[s + 1] - ax, dz = zs[s + 1] - az, l2 = dx * dx + dz * dz || 1e-9;
      const r = typeof R === 'number' ? R : Math.max(R[s], R[s + 1]);
      const i0 = Math.max(0, Math.floor((Math.min(ax, ax + dx) - r) / LAT)), i1 = Math.min(N - 1, Math.ceil((Math.max(ax, ax + dx) + r) / LAT));
      const j0 = Math.max(0, Math.floor((Math.min(az, az + dz) - r) / LAT)), j1 = Math.min(N - 1, Math.ceil((Math.max(az, az + dz) + r) / LAT));
      if (i0 < a0) a0 = i0; if (i1 > a1) a1 = i1; if (j0 < b0) b0 = j0; if (j1 > b1) b1 = j1;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = i * LAT - ax, pz = j * LAT - az; let t = (px * dx + pz * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - dx * t, qz = pz - dz * t, d = Math.sqrt(qx * qx + qz * qz);
        if (d > r) continue;
        const o = j * N + i;
        if (ID[o] !== id || d < D[o]) { ID[o] = id; D[o] = d; SI[o] = s + t; }
      }
    }
    for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) { const o = j * N + i; if (ID[o] === id) then(o, D[o], SI[o], i * LAT, j * LAT); }
  }
  const along = (A, si, n) => { const k = si | 0, k1 = k + 1 < n ? k + 1 : k; return A[k] + (A[k1] - A[k]) * (si - k); };

  // ---- the river: a bed below its level, banks that open out, and never land lower than the water beside it
  stamp(river.x, river.z, rn, reach, (o, d, si, x, z) => {
    const lv = along(wl, si, rn), w = along(hw, si, rn), e = d - w;
    if (e > 80) return;
    const sw = maskAt(x, z, 4);
    if (e <= 0) { const q = d / w, bed = lv - along(dp, si, rn) * (1 - q * q); if (bed < H[o]) H[o] = bed; wet[o] = 255; }
    else {
      const cap = lv + 0.35 + e * 0.08 + e * e * 0.012, low = lv + 0.35 + e * 0.02; let h = H[o];
      if (h > cap) h = cap; if (h < low) h = low;
      H[o] += (h - H[o]) * (1 - sw);                                             // in the Mirewood the river has no banks; it is the swamp
      wet[o] = 255 * (1 - e / 80);
    }
    if (lv > W[o]) W[o] = lv;
  });

  // ---- the dry canyon in the desert: deep in the middle, a ramp down at each end
  const can = spline(CANYON, 8), cf = new Float64Array(can.n);
  for (let i = 0; i < can.n; i++) cf[i] = hAt(can.x[i], can.z[i]);
  smooth(cf, 8);
  { const L = can.cum[can.n - 1]; for (let i = 0; i < can.n; i++) { if (i && cf[i] > cf[i - 1]) cf[i] = cf[i - 1]; } for (let i = 0; i < can.n; i++) cf[i] -= 30 * ss(0, 320, can.cum[i]) * ss(L, L - 320, can.cum[i]); }
  stamp(can.x, can.z, can.n, 90, (o, d, si) => {
    const e = d - 16, cap = along(cf, si, can.n) + (e <= 0 ? 0 : e < 14 ? e * 1.9 : 26.6 + (e - 14) * 0.25);
    if (H[o] > cap) H[o] = cap;
  });

  // ---- roads: levelled across their width, with the worst of the gradient cut out of the hills
  const roads = [];
  for (const def of ROADS) {
    const r = spline(def.pts, 8), y = new Float64Array(r.n);
    for (let i = 0; i < r.n; i++) y[i] = hAt(r.x[i], r.z[i]);
    smooth(y, 4);
    for (let i = 1; i < r.n; i++) { const lim = y[i - 1] + 0.16 * (r.cum[i] - r.cum[i - 1]); if (y[i] > lim) y[i] = lim; }
    for (let i = r.n - 2; i >= 0; i--) { const lim = y[i + 1] + 0.16 * (r.cum[i + 1] - r.cum[i]); if (y[i] > lim) y[i] = lim; }
    for (let i = 0; i < r.n; i++) if (maskAt(r.x[i], r.z[i], 4) > 0.04 && y[i] < SWAMP_LEVEL + 0.7) y[i] = SWAMP_LEVEL + 0.7;   // a causeway through the Mirewood
    stamp(r.x, r.z, r.n, 30, (o, d, si) => {
      if (wet[o] > 215) return;                                                  // the river is crossed by the bridge, not filled in
      const hc = along(y, si, r.n), cut = Math.abs(H[o] - hc), k = 1 - ss(4, 9 + cut * 1.3, d);
      if (k > 0) H[o] += (hc - H[o]) * k;
      const v = 255 * (1 - ss(2.6, 4.4, d)); if (v > road[o]) road[o] = v;
    });
    roads.push({ id: def.id, to: def.to, x: r.x, z: r.z, y, n: r.n, cum: r.cum });
  }

  const MAXF = N - 1.0001;
  return {
    seed, H, W, wet, road, masks, hubLevel, places,
    river: { x: river.x, z: river.z, wl, hw, n: rn, iHub, lakeEnd },
    canyon: { x: can.x, z: can.z, n: can.n }, roads, riverDist, maskAt,
    heightAt(x, z) {
      let fx = x / LAT, fz = z / LAT;
      if (fx < 0) fx = 0; else if (fx > MAXF) fx = MAXF;
      if (fz < 0) fz = 0; else if (fz > MAXF) fz = MAXF;
      const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, o = j * N + i;
      const a = H[o], b = H[o + 1], c = H[o + N], d = H[o + N + 1];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    },
    // the water surface over (x, z); far below the ground where there is none
    levelAt(x, z) {
      let fx = x / LAT, fz = z / LAT;
      if (fx < 0) fx = 0; else if (fx > MAXF) fx = MAXF;
      if (fz < 0) fz = 0; else if (fz > MAXF) fz = MAXF;
      const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, o = j * N + i;
      const a = W[o], b = W[o + 1], c = W[o + N], d = W[o + N + 1];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    },
  };
}
