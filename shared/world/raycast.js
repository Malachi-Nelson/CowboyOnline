// Rays against the ground, the water and bodies, for bullets. The server judges shots with these; the browser uses
// them only for where to put a muzzle's puff of dust. Nothing here has to agree to the bit between machines.
import { ZONE } from '../net/messages.js';

// Distance along a ray to the ground or the water surface, whichever comes first, or maxT. `out.water` says which.
// Marches in steps that shrink as the ray nears the ground, then closes in on the crossing.
export function rayGround(T, ox, oy, oz, dx, dy, dz, maxT, out) {
  out.water = false;
  const above = t => { const x = ox + dx * t, z = oz + dz * t, y = oy + dy * t, g = T.heightAt(x, z), l = T.levelAt(x, z); return y - (l > g ? l : g); };
  let t = 0, h = above(0);
  if (h <= 0) { out.water = T.levelAt(ox, oz) > T.heightAt(ox, oz); return 0; }
  while (t < maxT) {
    const step = h > 8 ? h * 0.8 : h > 2 ? 1.5 : 0.6, nt = t + (step < 0.6 ? 0.6 : step);
    const nh = above(nt > maxT ? maxT : nt);
    if (nh <= 0) {
      let a = t, b = nt > maxT ? maxT : nt;
      for (let i = 0; i < 12; i++) { const m = (a + b) * 0.5; if (above(m) > 0) a = m; else b = m; }
      const x = ox + dx * b, z = oz + dz * b;
      out.water = T.levelAt(x, z) > T.heightAt(x, z) + 0.02 && oy + dy * b <= T.levelAt(x, z) + 0.02;
      return b;
    }
    t = nt; h = nh;
  }
  return maxT;
}

// The shape of a person, for bullets: a head, a body and legs, standing or in the saddle. y is where their feet
// are, or for a rider where the horse's hooves are.
export const PERSON = {
  head: 1.63, headR: 0.15, body0: 0.85, body1: 1.5, bodyR: 0.27, legsR: 0.2,
  rideHead: 2.38, rideBody0: 1.62, rideBody1: 2.27, rideLegs0: 1.0, rideLegsR: 0.36,
};
// Distance to the first part of a person the ray meets, with which part in out.zone; maxT when it misses.
export function rayPerson(ox, oy, oz, dx, dy, dz, x, y, z, riding, maxT, out) {
  const P = PERSON;
  let best = maxT; out.zone = ZONE.NONE;
  const hy = y + (riding ? P.rideHead : P.head), th = raySphere(ox, oy, oz, dx, dy, dz, x, hy, z, P.headR);
  if (th < best) { best = th; out.zone = ZONE.HEAD; }
  const tb = riding ? rayCyl(ox, oy, oz, dx, dy, dz, x, z, P.bodyR, y + P.rideBody0, y + P.rideBody1) : rayCyl(ox, oy, oz, dx, dy, dz, x, z, P.bodyR, y + P.body0, y + P.body1);
  if (tb < best) { best = tb; out.zone = ZONE.BODY; }
  const tl = riding ? rayCyl(ox, oy, oz, dx, dy, dz, x, z, P.rideLegsR, y + P.rideLegs0, y + P.rideBody0) : rayCyl(ox, oy, oz, dx, dy, dz, x, z, P.legsR, y, y + P.body0);
  if (tl < best) { best = tl; out.zone = ZONE.LEGS; }
  return best;
}
// a horse: its barrel and quarters as one box, and its neck and head as another, turned to its heading
export function rayHorse(ox, oy, oz, dx, dy, dz, x, y, z, yaw, maxT) {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  // into the horse's own frame: forward is -z there, as it is in the world at yaw 0
  const px = ox - x, pz = oz - z, lx = px * c - pz * s, lz = px * s + pz * c, ldx = dx * c - dz * s, ldz = dx * s + dz * c, ly = oy - y;
  let t = rayAabb(lx, ly, lz, ldx, dy, ldz, -0.34, 0.34, 0.85, 1.56, -1.0, 1.0);
  const tn = rayAabb(lx, ly, lz, ldx, dy, ldz, -0.16, 0.16, 1.3, 2.3, -1.85, -0.9); if (tn < t) t = tn;
  return t < maxT ? t : maxT;
}

export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const px = ox - cx, py = oy - cy, pz = oz - cz, b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - r * r;
  const d = b * b - c; if (d < 0) return Infinity;
  const t = -b - Math.sqrt(d); return t >= 0 ? t : (c < 0 ? 0 : Infinity);
}
// a standing cylinder from y0 to y1, entered through its side or through its top or bottom
export function rayCyl(ox, oy, oz, dx, dy, dz, cx, cz, r, y0, y1) {
  const px = ox - cx, pz = oz - cz, a = dx * dx + dz * dz;
  let best = Infinity;
  if (a > 1e-12) {
    const b = px * dx + pz * dz, c = px * px + pz * pz - r * r, d = b * b - a * c;
    if (d >= 0) { const t = (-b - Math.sqrt(d)) / a; if (t >= 0) { const y = oy + dy * t; if (y >= y0 && y <= y1) best = t; } }
  }
  if (Math.abs(dy) > 1e-9) for (const yc of [y0, y1]) {
    const t = (yc - oy) / dy; if (t < 0 || t >= best) continue;
    const qx = px + dx * t, qz = pz + dz * t; if (qx * qx + qz * qz <= r * r) best = t;
  }
  return best;
}
export function rayAabb(ox, oy, oz, dx, dy, dz, x0, x1, y0, y1, z0, z1) {
  let t0 = 0, t1 = Infinity;
  for (const [o, d, a, b] of [[ox, dx, x0, x1], [oy, dy, y0, y1], [oz, dz, z0, z1]]) {
    if (Math.abs(d) < 1e-12) { if (o < a || o > b) return Infinity; continue; }
    let u = (a - o) / d, v = (b - o) / d; if (u > v) { const k = u; u = v; v = k; }
    if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return Infinity;
  }
  return t0;
}
