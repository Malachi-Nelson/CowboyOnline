// Small maths helpers, carried over from HoodWar's 10-core.js.
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapPi = a => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
export const angTo = (a, b) => wrapPi(b - a);                    // shortest signed turn from a to b
export const lerpAng = (a, b, t) => a + angTo(a, b) * t;
// forward is (-sin yaw, -cos yaw): yaw 0 faces north (-z), +x is east, +z is south
export const yawOf = (dx, dz) => Math.atan2(-dx, -dz);

// A small seeded generator (mulberry32). Same seed, same sequence, on every machine.
export function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Input sequence numbers are 16 bits and wrap; this is a - b across the wrap.
export const seqDiff = (a, b) => (((a - b) + 32768) & 65535) - 32768;

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}
