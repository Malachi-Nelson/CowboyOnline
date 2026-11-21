// Solid boxes, carried over from HoodWar's 30-physics.js: every solid is an axis-aligned box that is both a wall
// and a floor. Boxes live in a sparse grid of 16 m cells so a query only looks at what is near.
import { clamp } from '../math.js';

const CELL = 16, SPAN = 4096;

export class BoxWorld {
  constructor() {
    this.boxes = [];
    this.grid = new Map();
    this.stamp = 0;
    // result of the last pushOut
    this.x = 0; this.z = 0; this.nx = 0; this.nz = 0;
  }
  solid(x0, x1, y0, y1, z0, z1) {
    const b = { x0, x1, y0, y1, z0, z1, rs: 0 };
    this.boxes.push(b);
    const a0 = Math.floor(x0 / CELL), a1 = Math.floor(x1 / CELL), c0 = Math.floor(z0 / CELL), c1 = Math.floor(z1 / CELL);
    for (let cz = c0; cz <= c1; cz++) for (let cx = a0; cx <= a1; cx++) {
      const k = cz * SPAN + cx; let L = this.grid.get(k);
      if (!L) this.grid.set(k, L = []);
      L.push(b);
    }
    return b;
  }
  // Push a circle out of every box whose height span overlaps ya..yb. Returns how many it touched; the result is
  // left in this.x, this.z, with the direction it was pushed in this.nx, this.nz.
  pushOut(x, z, r, ya, yb) {
    let n = 0; const sx = x, sz = z;
    for (let it = 0; it < 2; it++) {
      const a0 = Math.floor((x - r) / CELL), a1 = Math.floor((x + r) / CELL), c0 = Math.floor((z - r) / CELL), c1 = Math.floor((z + r) / CELL);
      for (let cz = c0; cz <= c1; cz++) for (let cx = a0; cx <= a1; cx++) {
        const L = this.grid.get(cz * SPAN + cx); if (!L) continue;
        for (let i = 0; i < L.length; i++) {
          const b = L[i];
          if (b.y1 <= ya || b.y0 >= yb) continue;
          const px = clamp(x, b.x0, b.x1), pz = clamp(z, b.z0, b.z1), dx = x - px, dz = z - pz, d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          n++;
          if (d2 > 1e-9) { const d = Math.sqrt(d2), k = (r - d) / d; x += dx * k; z += dz * k; }
          else {
            const l = x - b.x0, rr = b.x1 - x, nn = z - b.z0, s = b.z1 - z, m = Math.min(l, rr, nn, s);
            if (m === l) x = b.x0 - r; else if (m === rr) x = b.x1 + r; else if (m === nn) z = b.z0 - r; else z = b.z1 + r;
          }
        }
      }
    }
    this.x = x; this.z = z;
    if (n) { const l = Math.sqrt((x - sx) * (x - sx) + (z - sz) * (z - sz)) || 1; this.nx = (x - sx) / l; this.nz = (z - sz) / l; }
    return n;
  }
  // The highest box top under (x, z) that feet at `feet` could step onto. -Infinity when there is none.
  topUnder(x, z, feet, step) {
    let g = -Infinity; const r = 0.15, lim = feet + step + 0.001;
    const a0 = Math.floor((x - r) / CELL), a1 = Math.floor((x + r) / CELL), c0 = Math.floor((z - r) / CELL), c1 = Math.floor((z + r) / CELL);
    for (let cz = c0; cz <= c1; cz++) for (let cx = a0; cx <= a1; cx++) {
      const L = this.grid.get(cz * SPAN + cx); if (!L) continue;
      for (let i = 0; i < L.length; i++) {
        const b = L[i];
        if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r && b.y1 <= lim && b.y1 > g) g = b.y1;
      }
    }
    return g;
  }
  // Distance along a ray to the nearest box, or maxT; the box it met is left in this.hit. Walks the grid cell by cell.
  ray(ox, oy, oz, dx, dy, dz, maxT) {
    let best = maxT; const stamp = ++this.stamp; this.hit = null;
    let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1, adx = Math.abs(dx), adz = Math.abs(dz);
    const tDX = adx > 1e-9 ? CELL / adx : Infinity, tDZ = adz > 1e-9 ? CELL / adz : Infinity;
    let tMX = adx > 1e-9 ? (dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL) / adx : Infinity;
    let tMZ = adz > 1e-9 ? (dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL) / adz : Infinity;
    for (let guard = 0; guard < 400; guard++) {
      const L = this.grid.get(cz * SPAN + cx);
      if (L) for (let i = 0; i < L.length; i++) { const b = L[i]; if (b.rs === stamp) continue; b.rs = stamp; const h = rayBox(ox, oy, oz, dx, dy, dz, b); if (h < best) { best = h; this.hit = b; } }
      const tExit = tMX < tMZ ? tMX : tMZ;
      if (best <= tExit || tExit >= maxT) break;
      if (tMX < tMZ) { cx += sx; tMX += tDX; } else { cz += sz; tMZ += tDZ; }
    }
    return best;
  }
}

export function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let t0 = 0, t1 = 1e9, a, c, s;
  if (Math.abs(dx) < 1e-9) { if (ox < b.x0 || ox > b.x1) return Infinity; } else { a = (b.x0 - ox) / dx; c = (b.x1 - ox) / dx; if (a > c) { s = a; a = c; c = s; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return Infinity; }
  if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.y1) return Infinity; } else { a = (b.y0 - oy) / dy; c = (b.y1 - oy) / dy; if (a > c) { s = a; a = c; c = s; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return Infinity; }
  if (Math.abs(dz) < 1e-9) { if (oz < b.z0 || oz > b.z1) return Infinity; } else { a = (b.z0 - oz) / dz; c = (b.z1 - oz) / dz; if (a > c) { s = a; a = c; c = s; } if (a > t0) t0 = a; if (c < t1) t1 = c; if (t0 > t1) return Infinity; }
  return t0;
}
