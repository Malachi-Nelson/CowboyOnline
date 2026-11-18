// The ground, out to the horizon. Four square rings of mesh centred on the viewer, each twice as coarse as the one
// inside it (4, 8, 16 and 32 m between points), read straight from the same height lattice the server walks bodies
// over. The inner ring is exact; the outer ones are for the mountains on the skyline. A ring is rebuilt only when
// the viewer has moved two of its own cells, so the far ones are almost never touched.
//
// Colour is painted once per lattice point from what the place is (grass, forest floor, sand, rock, snow, mud,
// road) and kept; the rings copy it. The same painting makes the map.
import { THREE } from './three.js';
import { LAT, LAT_N, MASK_N, vnoise, ss } from '../../../shared/world/terrain.js';
import { TREE_N } from '../../../shared/world/trees.js';
import { CHUNK, WORLD_SIZE } from '../../../shared/constants.js';

const G = 128, LEVELS = 4, VN = (G + 1) * (G + 1), SKIRT = 4 * (G + 1);
const rgb = h => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const TONE = { dry: rgb(0xa39a58), green: rgb(0x77843f), floor: rgb(0x4d5631), sand: rgb(0xcbb07a), red: rgb(0xb06a42), band: rgb(0xc99560), mud: rgb(0x5a5a32), snow: rgb(0xe8edf1), rock: rgb(0x7f766a), high: rgb(0x93928d), gravel: rgb(0xb4a682), dirt: rgb(0xa1865c), pad: rgb(0x9d8868), deep: rgb(0x21414b) };
const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }

// ---- what colour the ground is at every lattice point, as sRGB bytes
function paint(field) {
  const t = field.terrain, N = LAT_N, H = t.H, W = t.W, M = t.masks, T = field.trees.T, sd = field.seed | 0, out = new Uint8Array(N * N * 3), c = [0, 0, 0];
  const mix = (b, k) => { if (k <= 0) return; if (k > 1) k = 1; c[0] += (b[0] - c[0]) * k; c[1] += (b[1] - c[1]) * k; c[2] += (b[2] - c[2]) * k; };
  const pads = field.places;
  for (let j = 0; j < N; j++) {
    const jm = j > 0 ? j - 1 : j, jp = j < N - 1 ? j + 1 : j;
    for (let i = 0; i < N; i++) {
      const o = j * N + i, x = i * LAT, z = j * LAT, h = H[o], im = i > 0 ? i - 1 : i, ip = i < N - 1 ? i + 1 : i;
      const gx = (H[j * N + ip] - H[j * N + im]) / ((ip - im) * LAT), gz = (H[jp * N + i] - H[jm * N + i]) / ((jp - jm) * LAT), slope = Math.sqrt(gx * gx + gz * gz);
      const q = ((j >> 1) * MASK_N + (i >> 1)) * 5, north = M[q] / 255, mount = M[q + 1] / 255, desert = M[q + 3] / 255, swamp = M[q + 4] / 255, wet = t.wet[o] / 255;
      const n1 = vnoise(x / 110, z / 110, sd + 31), n2 = vnoise(x / 23, z / 23, sd + 32);
      // grass: gold on the rises, green in the low ground and by water
      c[0] = TONE.dry[0]; c[1] = TONE.dry[1]; c[2] = TONE.dry[2];
      mix(TONE.green, 0.3 + (n1 - 0.5) * 1.3 + wet * 0.7 + mount * 0.5 + (n2 - 0.5) * 0.4);
      // under the trees
      const cx = (i >> 1) < TREE_N ? i >> 1 : TREE_N - 1, cz = (j >> 1) < TREE_N ? j >> 1 : TREE_N - 1; let tr = 0;
      for (let b = cz > 0 ? cz - 1 : 0; b <= (cz < TREE_N - 1 ? cz + 1 : cz); b++) for (let a = cx > 0 ? cx - 1 : 0; a <= (cx < TREE_N - 1 ? cx + 1 : cx); a++) if (T[b * TREE_N + a]) tr++;
      if (desert < 0.5 && swamp < 0.5) mix(TONE.floor, tr / 9 * 0.85);
      if (desert > 0) { mix(TONE.sand, desert * (0.85 + (n2 - 0.5) * 0.3)); if (slope > 0.25) { const f = h / 5.5, band = f - Math.floor(f); mix(band < 0.45 ? TONE.red : TONE.band, desert * ss(0.25, 0.7, slope)); } }
      if (swamp > 0) mix(TONE.mud, swamp * 0.9);
      if (slope > 0.55 && desert < 0.6) mix(h > 150 ? TONE.high : TONE.rock, ss(0.55, 0.95, slope));
      if (wet > 0.8 && swamp < 0.5) mix(TONE.gravel, ss(0.8, 0.97, wet) * 0.75);              // a strip of shingle at the water's edge
      const snow = Math.max(ss(0.38, 0.62, north + (n1 - 0.5) * 0.25), ss(255, 300, h + (n1 - 0.5) * 60));
      if (snow > 0) mix(TONE.snow, snow * (1 - ss(0.9, 1.5, slope) * 0.8));
      if (t.road[o]) mix(snow > 0.5 ? TONE.rock : TONE.dirt, t.road[o] / 255 * 0.92);
      for (const p of pads) { const dz = Math.abs(z - p.z); if (dz < p.r + 30) { const ax = p.ax || p.x, bx = p.bx || p.x, dx = x < ax ? ax - x : x > bx ? x - bx : 0, d = Math.sqrt(dx * dx + dz * dz); if (d < p.r + 30) mix(snow > 0.5 ? TONE.snow : p.id === 'dryfork' ? TONE.sand : TONE.pad, ss(p.r + 30, p.r - 25, d) * (snow > 0.5 ? 0.5 : 0.8)); } }
      const depth = W[o] - h; if (depth > 0) mix(TONE.deep, 0.4 + depth * 0.3 > 0.9 ? 0.9 : 0.4 + depth * 0.3);
      const v = 0.94 + ((Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0) % 1000 / 1000 * 0.12;
      out[o * 3] = Math.min(255, c[0] * v); out[o * 3 + 1] = Math.min(255, c[1] * v); out[o * 3 + 2] = Math.min(255, c[2] * v);
    }
  }
  return out;
}

export function createTerrain(scene, field, env) {
  const t = field.terrain;
  // heights and colours at each ring's own spacing. A coarse point in the river takes the lowest height around it,
  // so the channel does not close up in the distance; everywhere else it is the height at that very spot.
  const Hm = [t.H], Cm = [paint(field)], Nm = [LAT_N], Rm = [t.wet];
  for (let k = 1; k < LEVELS; k++) {
    const pn = Nm[k - 1], n = (pn - 1) / 2 + 1, pH = Hm[k - 1], pC = Cm[k - 1], pR = Rm[k - 1], h = new Float32Array(n * n), c = new Uint8Array(n * n * 3), r = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const pi = i * 2, pj = j * 2, o = j * n + i; let lo = pH[pj * pn + pi], river = 0, cr = 0, cg = 0, cb = 0, cw = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const x = pi + a, y = pj + b; if (x < 0 || y < 0 || x >= pn || y >= pn) continue;
        const q = y * pn + x, w = (a ? 1 : 2) * (b ? 1 : 2); if (pR[q] === 255) { river = 255; if (pH[q] < lo) lo = pH[q]; }
        cr += pC[q * 3] * w; cg += pC[q * 3 + 1] * w; cb += pC[q * 3 + 2] * w; cw += w;
      }
      h[o] = river ? lo : pH[pj * pn + pi]; r[o] = river; c[o * 3] = cr / cw; c[o * 3 + 1] = cg / cw; c[o * 3 + 2] = cb / cw;
    }
    Hm.push(h); Cm.push(c); Nm.push(n); Rm.push(r);
  }

  // fine grain, so the ground is not one flat colour up close
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g2 = cv.getContext('2d'), img = g2.createImageData(128, 128);
  let s = 1899; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 128 * 128; i++) { const v = 200 + rnd() * 55; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.97; img.data[i * 4 + 3] = 255; }
  g2.putImageData(img, 0, 0);
  const grain = new THREE.CanvasTexture(cv); grain.wrapS = grain.wrapT = THREE.RepeatWrapping; grain.anisotropy = 4;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: grain });
  mat.extensions = { derivatives: true };
  const uni = { uGrid: { value: 0 }, uEye: { value: new THREE.Vector3() } };
  // A surveyor's grid, for the instruments: a faint line every 8 m to judge speed by, and a stronger one every
  // 128 m, which is exactly the square the server sorts everything into to decide who can see whom.
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <uv_vertex>', 'vUv = position.xz * 0.125;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nuniform float uGrid;\nuniform vec3 uEye;')
      .replace('#include <map_fragment>', `{ float dist = distance(vWorld.xz, uEye.xz); vec4 tex = texture2D(map, vUv); diffuseColor.rgb *= mix(tex.rgb, vec3(0.89), smoothstep(30.0, 160.0, dist)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uGrid > 0.0) {
          float dist = distance(vWorld.xz, uEye.xz);
          vec2 a = vWorld.xz / 8.0, b = vWorld.xz / ${CHUNK.toFixed(1)};
          vec2 ga = abs(fract(a - 0.5) - 0.5) / fwidth(a), gb = abs(fract(b - 0.5) - 0.5) / fwidth(b);
          float fine = (1.0 - min(min(ga.x, ga.y), 1.0)) * (1.0 - smoothstep(40.0, 150.0, dist));
          float cell = (1.0 - min(min(gb.x, gb.y) * 0.6, 1.0)) * (1.0 - smoothstep(250.0, 520.0, dist));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.015, 0.008), uGrid * fine * 0.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.6, 0.22), uGrid * cell * 0.6);
        }`);
  };

  // ---- the rings
  const rings = [];
  for (let k = 0; k < LEVELS; k++) {
    const geo = new THREE.BufferGeometry(), pos = new Float32Array((VN + SKIRT) * 3), nor = new Float32Array((VN + SKIRT) * 3), col = new Float32Array((VN + SKIRT) * 3);
    const idx = new Uint16Array(G * G * 6 + 4 * G * 12);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; scene.add(mesh);
    rings.push({ k, cell: LAT << k, geo, pos, nor, col, idx, mesh, cx: 1e9, cz: 1e9, hx: 1e9, hz: 1e9 });
  }

  function fill(r) {
    const k = r.k, n = Nm[k], H = Hm[k], C = Cm[k], c = r.cell, x0 = r.cx - G / 2, z0 = r.cz - G / 2, pos = r.pos, nor = r.nor, col = r.col, lim = n - 1;
    const hAt = (i, j) => H[(j < 0 ? 0 : j > lim ? lim : j) * n + (i < 0 ? 0 : i > lim ? lim : i)];
    for (let gj = 0, v = 0; gj <= G; gj++) for (let gi = 0; gi <= G; gi++, v += 3) {
      const i = x0 + gi, j = z0 + gj, ci = i < 0 ? 0 : i > lim ? lim : i, cj = j < 0 ? 0 : j > lim ? lim : j, o = cj * n + ci;
      // beyond the edge of the map the land falls away, into the sea
      const out = Math.max(ci - i, i - ci, cj - j, j - cj) * c;
      pos[v] = i * c; pos[v + 1] = H[o] - out * 0.25; pos[v + 2] = j * c;
      const dx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * c), dz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * c), l = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      nor[v] = -dx * l; nor[v + 1] = l; nor[v + 2] = -dz * l;
      col[v] = LIN[C[o * 3]]; col[v + 1] = LIN[C[o * 3 + 1]]; col[v + 2] = LIN[C[o * 3 + 2]];
    }
    // a skirt hanging from the outer edge hides the hairline gaps where this ring meets the coarser one
    const drop = c * 0.75 + 1.5; let v = VN * 3;
    const hang = a => { pos[v] = pos[a * 3]; pos[v + 1] = pos[a * 3 + 1] - drop; pos[v + 2] = pos[a * 3 + 2]; nor[v] = nor[a * 3]; nor[v + 1] = nor[a * 3 + 1]; nor[v + 2] = nor[a * 3 + 2]; col[v] = col[a * 3]; col[v + 1] = col[a * 3 + 1]; col[v + 2] = col[a * 3 + 2]; v += 3; };
    for (let i = 0; i <= G; i++) hang(i); for (let i = 0; i <= G; i++) hang(G * (G + 1) + i); for (let i = 0; i <= G; i++) hang(i * (G + 1)); for (let i = 0; i <= G; i++) hang(i * (G + 1) + G);
    r.geo.attributes.position.needsUpdate = r.geo.attributes.normal.needsUpdate = r.geo.attributes.color.needsUpdate = true;
  }
  // the triangles of a ring, leaving out the square the next finer ring covers
  function weave(r, hole) {
    const idx = r.idx; let n = 0;
    for (let z = 0; z < G; z++) for (let x = 0; x < G; x++) {
      if (hole && x >= r.hx && x < r.hx + G / 2 && z >= r.hz && z < r.hz + G / 2) continue;
      const a = z * (G + 1) + x, b = a + 1, c = a + G + 1, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
    const edge = [i => i, i => G * (G + 1) + i, i => i * (G + 1), i => i * (G + 1) + G];
    for (let e = 0; e < 4; e++) for (let i = 0; i < G; i++) {
      const a = edge[e](i), b = edge[e](i + 1), c = VN + e * (G + 1) + i, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d; idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = b; idx[n++] = d; idx[n++] = c;
    }
    r.geo.setDrawRange(0, n); r.geo.index.needsUpdate = true;
  }

  return {
    uni, colours: Cm[0],
    // keep the rings centred on the viewer. At most one ring is rebuilt per call, nearest first, so a fast rider
    // never pays for more than one in a frame.
    update(x, z, eye) {
      uni.uEye.value.copy(eye);
      let built = false;
      for (let k = 0; k < LEVELS; k++) {
        const r = rings[k], c = r.cell, cx = Math.round(x / (2 * c)) * 2, cz = Math.round(z / (2 * c)) * 2;
        if ((cx !== r.cx || cz !== r.cz) && (!built || r.cx > 1e8)) { r.cx = cx; r.cz = cz; fill(r); built = true; r.hx = 1e9; if (k + 1 < LEVELS) rings[k + 1].hx = 1e9; }
      }
      for (let k = 0; k < LEVELS; k++) {
        const r = rings[k];
        if (k === 0) { if (r.hx > 1e8) { r.hx = 0; weave(r, false); } continue; }
        const f = rings[k - 1], hx = f.cx / 2 - r.cx + G / 4, hz = f.cz / 2 - r.cz + G / 4;
        if (hx !== r.hx || hz !== r.hz) { r.hx = hx; r.hz = hz; weave(r, true); }
      }
    },
    // the whole territory from above, one pixel per lattice point, for the map
    paintMap(canvas) {
      const N = LAT_N - 1, C = Cm[0], W = t.W, H = t.H; canvas.width = canvas.height = N;
      const ctx = canvas.getContext('2d'), im = ctx.createImageData(N, N), d = im.data;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const o = j * LAT_N + i, p = (j * N + i) * 4, water = W[o] > H[o] + 0.05, sh = Math.max(0.72, Math.min(1.2, 1 + (H[o] - H[o + 1] + H[o] - H[o + LAT_N]) * 0.06));   // lit from the north-west
        if (water) { d[p] = 74; d[p + 1] = 118; d[p + 2] = 132; } else { d[p] = Math.min(255, C[o * 3] * sh); d[p + 1] = Math.min(255, C[o * 3 + 1] * sh); d[p + 2] = Math.min(255, C[o * 3 + 2] * sh); }
        d[p + 3] = 255;
      }
      ctx.putImageData(im, 0, 0);
      return canvas;
    },
    dispose() { for (const r of rings) { scene.remove(r.mesh); r.geo.dispose(); } mat.dispose(); grain.dispose(); },
  };
}

// ---- water: the river as a ribbon that follows its fall, and one sheet at the level of the Mirewood that runs out
// to the horizon as the sea. Where the land is above it, the land hides it.
const WATER_VERT = `
attribute float foam; varying vec3 vW; varying float vFoam;
#include <fog_pars_vertex>
void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; vFoam = foam; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_FRAG = `
uniform vec3 uDeep, uSky, uSunDir, uSunCol, uEye; uniform float uTime;
varying vec3 vW; varying float vFoam;
#include <fog_pars_fragment>
void main() {
  vec3 V = normalize(uEye - vW); vec2 p = vW.xz; float t = uTime, far = smoothstep(60.0, 400.0, distance(uEye, vW));
  vec3 n = normalize(vec3((sin(p.x * 0.9 + t * 1.3) * 0.05 + sin(p.y * 1.7 - t * 1.1 + p.x * 0.4) * 0.04) * (1.0 - far), 1.0, (cos(p.y * 1.1 + t * 0.9) * 0.05 + sin(p.x * 2.1 + t * 1.7) * 0.03) * (1.0 - far)));
  float fr = pow(1.0 - max(dot(V, n), 0.0), 3.0);
  vec3 col = mix(uDeep, uSky * 0.85, 0.06 + 0.62 * fr);
  col += uSunCol * pow(max(dot(reflect(-V, n), uSunDir), 0.0), 140.0) * 0.7;
  col = mix(col, uSky * 0.6 + vec3(0.35), clamp(vFoam, 0.0, 1.0) * (0.6 + 0.4 * sin(p.x * 3.1 + p.y * 2.3 - t * 6.0)));
  gl_FragColor = vec4(col, mix(0.7, 0.96, fr) + vFoam * 0.25);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
  #include <fog_fragment>
}`;
export function createWater(scene, field) {
  const t = field.terrain, r = t.river, uni = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uDeep: { value: new THREE.Color() }, uSky: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() }, uEye: { value: new THREE.Vector3() }, uTime: { value: 0 } }]);
  const mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false, fog: true });
  const pos = [], foam = [], idx = [];
  // the river: two points a sample, either side of its course
  for (let i = 0; i < r.n; i++) {
    const a = i > 0 ? i - 1 : 0, b = i < r.n - 1 ? i + 1 : i, tx = r.x[b] - r.x[a], tz = r.z[b] - r.z[a], l = Math.hypot(tx, tz) || 1, w = r.hw[i] + 2.5;
    const fall = i > 0 ? (r.wl[i - 1] - r.wl[i]) / 8 : 0, f = Math.min(1, Math.max(0, (fall - 0.02) * 9));
    pos.push(r.x[i] + tz / l * w, r.wl[i], r.z[i] - tx / l * w, r.x[i] - tz / l * w, r.wl[i], r.z[i] + tx / l * w); foam.push(f, f);
    if (i) { const o = i * 2; idx.push(o - 2, o - 1, o, o - 1, o + 1, o); }   // facing up
  }
  // the head of the lake, a half disc behind the first sample
  { const c = pos.length / 3, tx = r.x[1] - r.x[0], tz = r.z[1] - r.z[0], l = Math.hypot(tx, tz), ang = Math.atan2(tz, tx), R = r.hw[0] + 2.5; pos.push(r.x[0], r.wl[0], r.z[0]); foam.push(0);
    for (let k = 0; k <= 12; k++) { const a = ang + Math.PI / 2 + k / 12 * Math.PI; pos.push(r.x[0] + Math.cos(a) * R, r.wl[0], r.z[0] + Math.sin(a) * R); foam.push(0); if (k) idx.push(c, c + k + 1, c + k); } void l; }
  // the sea
  { const c = pos.length / 3, y = r.wl[r.n - 1], lo = -9000, hi = WORLD_SIZE + 9000; pos.push(lo, y, lo, hi, y, lo, lo, y, hi, hi, y, hi); foam.push(0, 0, 0, 0); idx.push(c, c + 2, c + 1, c + 1, c + 2, c + 3); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('foam', new THREE.Float32BufferAttribute(foam, 1)); geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 2; scene.add(mesh);
  const deepDay = new THREE.Color(0x1f4a55).convertSRGBToLinear();
  return {
    mesh,
    update(time, env, eye) {
      uni.uTime.value = time; uni.uEye.value.copy(eye); uni.uSunDir.value.copy(env.light);
      uni.uSunCol.value.copy(env.sunCol); uni.uSky.value.copy(env.zenith).lerp(env.horizon, 0.55);
      uni.uDeep.value.copy(deepDay).multiplyScalar(0.12 + 0.88 * env.day);
    },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
