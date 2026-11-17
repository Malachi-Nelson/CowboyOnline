// Sine and cosine for the 65,536 directions a view can face, and for small turns, worked out with plain
// arithmetic. Math.sin and Math.cos are computed by each JavaScript engine's own code and can differ in the last
// bit from one engine to the next; +, -, *, / and Math.sqrt go straight to the processor and do not. Movement
// uses only these, so every browser and the Node server step a body to exactly the same place.
const STEP = Math.PI / 32768;
const sinP = t => { const q = t * t; return t * (1 - q / 6 * (1 - q / 20 * (1 - q / 42 * (1 - q / 72 * (1 - q / 110 * (1 - q / 156)))))); };
const cosP = t => { const q = t * t; return 1 - q / 2 * (1 - q / 12 * (1 - q / 30 * (1 - q / 56 * (1 - q / 90 * (1 - q / 132))))); };

export const SIN16 = new Float32Array(65536);
export const COS16 = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const r = i & 16383, s = r <= 8192 ? sinP(r * STEP) : cosP((16384 - r) * STEP), c = r <= 8192 ? cosP(r * STEP) : sinP((16384 - r) * STEP);
  switch (i >> 14) {
    case 0: SIN16[i] = s; COS16[i] = c; break;
    case 1: SIN16[i] = c; COS16[i] = -s; break;
    case 2: SIN16[i] = -s; COS16[i] = -c; break;
    default: SIN16[i] = -c; COS16[i] = s;
  }
}
// for angles up to about a quarter of a radian (a turn made in one step)
export const sinSmall = a => { const q = a * a; return a * (1 - q / 6 * (1 - q / 20 * (1 - q / 42))); };
export const cosSmall = a => { const q = a * a; return 1 - q / 2 * (1 - q / 12 * (1 - q / 30 * (1 - q / 56))); };
