// Trees, as one byte for every 8 m square of the map: which kind stands there (if any) and how big. Where exactly
// in its square a tree stands comes from a hash, so nothing but that byte needs storing. The server and every
// browser grow the same forest from the seed, the server so that trunks stop bodies, the browser so it can draw them.
import { WORLD_SIZE } from '../constants.js';
import { hash2, vnoise, ss, distSeg, LAT, LAT_N } from './terrain.js';

export const TREE_CELL = 8;
export const TREE_N = WORLD_SIZE / TREE_CELL;
export const TREE = { PINE: 1, OAK: 2, CYPRESS: 3, CACTUS: 4, SNOWPINE: 5, DEAD: 6, BIRCH: 7 };
// trunk radius at chest height for a tree of size 1, by kind
const TRUNK = [0, 0.3, 0.42, 0.5, 0.3, 0.3, 0.22, 0.2];
export const treeSize = v => 0.75 + (v >> 3) / 31 * 0.65;

export function makeTrees(t, seed) {
  const N = TREE_N, T = new Uint8Array(N * N), sd = seed | 0, places = t.places;
  const jx = (cx, cz) => (cx + 0.5) * TREE_CELL + (hash2(cx, cz, sd + 101) - 0.5) * 6;
  const jz = (cx, cz) => (cz + 0.5) * TREE_CELL + (hash2(cx, cz, sd + 202) - 0.5) * 6;
  const roadAt = (x, z) => { const i = (x / LAT + 0.5) | 0, j = (z / LAT + 0.5) | 0; return i < 0 || j < 0 || i >= LAT_N || j >= LAT_N ? 0 : t.road[j * LAT_N + i]; };
  const wetAt = (x, z) => { const i = (x / LAT + 0.5) | 0, j = (z / LAT + 0.5) | 0; return i < 0 || j < 0 || i >= LAT_N || j >= LAT_N ? 0 : t.wet[j * LAT_N + i]; };

  for (let cz = 0; cz < N; cz++) for (let cx = 0; cx < N; cx++) {
    const x = jx(cx, cz), z = jz(cx, cz);
    if (roadAt(x, z) || roadAt(x - 5, z) || roadAt(x + 5, z) || roadAt(x, z - 5) || roadAt(x, z + 5)) continue;
    let clear = false;
    for (const p of places) if (Math.abs(z - p.z) < p.r + 20 && distSeg(x, z, p.ax || p.x, p.z, p.bx || p.x, p.z) < p.r + 14) { clear = true; break; }
    if (clear) continue;
    const h = t.heightAt(x, z), gx = t.heightAt(x + 2, z) - t.heightAt(x - 2, z), gz = t.heightAt(x, z + 2) - t.heightAt(x, z - 2);
    if (gx * gx + gz * gz > 9) continue;                                         // steeper than about 37 degrees: bare rock
    const depth = t.levelAt(x, z) - h, wet = wetAt(x, z);
    const north = t.maskAt(x, z, 0), mount = t.maskAt(x, z, 1), forest = t.maskAt(x, z, 2), desert = t.maskAt(x, z, 3), swamp = t.maskAt(x, z, 4);
    const r = hash2(cx, cz, sd + 303), r2 = hash2(cx, cz, sd + 404);
    let p = 0, kind = 0;
    if (depth > 0.05) { if (swamp > 0.5 && depth < 0.9 && wet < 200) { p = 0.4; kind = TREE.CYPRESS; } }
    else if (swamp > 0.5) { p = 0.5; kind = r2 < 0.8 ? TREE.CYPRESS : TREE.OAK; }
    else if (desert > 0.5) { p = 0.03 + ss(0.6, 0.8, vnoise(x / 140, z / 140, sd + 23)) * 0.05; kind = r2 < 0.72 ? TREE.CACTUS : TREE.DEAD; }
    else if (wet > 250) p = 0;                                                    // the river bed
    else {
      const f = forest * (0.5 + 1.0 * vnoise(x / 260, z / 260, sd + 21));
      p = ss(0.22, 0.6, f) * 0.88;
      if (h > 235) p *= ss(285, 235, h);                                         // the treeline
      if (north > 0.3) p *= 0.25 + 0.75 * ss(0.42, 0.66, vnoise(x / 330, z / 330, sd + 24));   // the high country is stands of pine and open snow
      const grove = ss(0.7, 0.84, vnoise(x / 150, z / 150, sd + 22)) * 0.5 * (1 - desert) * (1 - swamp);
      if (grove > p) p = grove;
      if (wet > 20 && p < 0.3) p = 0.3;                                          // cottonwoods along the banks
      if (p < 0.012) p = 0.012;                                                  // a lone tree here and there
      p *= 1 - desert * 0.9;
      const snowy = north > 0.45 || h > 255;
      kind = snowy ? TREE.SNOWPINE : h > 105 || mount > 0.3 ? TREE.PINE : r2 < forest * 0.65 ? TREE.PINE : r2 < 0.86 ? TREE.OAK : TREE.BIRCH;
    }
    if (kind && r < p) T[cz * N + cx] = kind | (((hash2(cx, cz, sd + 505) * 32) | 0) << 3);
  }

  const out = {
    T, x: 0, z: 0, nx: 0, nz: 0,
    posX: jx, posZ: jz,
    // Push a circle out of any trunk it overlaps. Same contract as BoxWorld.pushOut.
    pushOut(x, z, r) {
      const R = r + 0.75, c0 = Math.floor((x - R) / TREE_CELL), c1 = Math.floor((x + R) / TREE_CELL), d0 = Math.floor((z - R) / TREE_CELL), d1 = Math.floor((z + R) / TREE_CELL);
      let n = 0; const sx = x, sz = z;
      for (let cz = d0; cz <= d1; cz++) for (let cx = c0; cx <= c1; cx++) {
        if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
        const v = T[cz * N + cx]; if (!v) continue;
        const tr = TRUNK[v & 7] * treeSize(v) + r, dx = x - jx(cx, cz), dz = z - jz(cx, cz), d2 = dx * dx + dz * dz;
        if (d2 >= tr * tr) continue;
        n++;
        if (d2 > 1e-9) { const d = Math.sqrt(d2), k = (tr - d) / d; x += dx * k; z += dz * k; } else x += tr;
      }
      out.x = x; out.z = z;
      if (n) { const l = Math.sqrt((x - sx) * (x - sx) + (z - sz) * (z - sz)) || 1; out.nx = (x - sx) / l; out.nz = (z - sz) / l; }
      return n;
    },
  };
  return out;
}
export const NO_TREES = { T: null, x: 0, z: 0, nx: 0, nz: 0, pushOut() { return 0; } };
