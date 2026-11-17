// Ground height. Phase 2 generates rolling country from a seed; Phase 3 swaps in baked height files behind the
// same heightAt(). Heights sit on a 4 m lattice and are read bilinearly, so the browser's mesh and the server's
// physics agree exactly. Only + - * / and Math.sqrt are used to make the lattice, which keeps every JavaScript
// engine in step (Math.sin and friends may differ in the last bit between engines).
import { WORLD_SIZE, HUB_X, HUB_Z } from '../constants.js';

export const LAT = 4;
export const LAT_N = WORLD_SIZE / LAT + 1;

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function makeTerrain(seed) {
  const H = new Float32Array(LAT_N * LAT_N);
  for (let j = 0; j < LAT_N; j++) {
    for (let i = 0; i < LAT_N; i++) {
      const x = i * LAT, z = j * LAT;
      const h = (vnoise(x / 320, z / 320, seed) - 0.5) * 44 + (vnoise(x / 96, z / 96, seed + 7) - 0.5) * 9 + (vnoise(x / 28, z / 28, seed + 13) - 0.5) * 1.6;
      // the hub stands on a flat table that blends into the hills
      const dx = x - HUB_X, dz = z - HUB_Z, d = Math.sqrt(dx * dx + dz * dz);
      const k = d < 70 ? 0 : d > 220 ? 1 : (d - 70) / 150, s = k * k * (3 - 2 * k);
      H[j * LAT_N + i] = 20 + h * s;
    }
  }
  const MAXF = LAT_N - 1.0001;
  return {
    seed, H,
    heightAt(x, z) {
      let fx = x / LAT, fz = z / LAT;
      if (fx < 0) fx = 0; else if (fx > MAXF) fx = MAXF;
      if (fz < 0) fz = 0; else if (fz > MAXF) fz = MAXF;
      const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, o = j * LAT_N + i;
      const a = H[o], b = H[o + 1], c = H[o + LAT_N], d = H[o + LAT_N + 1];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    },
  };
}
