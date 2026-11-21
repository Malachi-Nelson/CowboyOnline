// How other people and animals are drawn: a little in the past, sliding between the positions the server sent.
// Each remote entity keeps its last few samples; every frame it is placed at (server time - delay).
import { TICK_MS, ST_MOVE } from '../../../shared/constants.js';
import { lerpAng } from '../../../shared/math.js';

const N = 24;                    // samples kept per entity
const EXTRAPOLATE_MS = 100;      // how far a moving body is carried forward when its next update is late

// How often the server updates something at distance d, in ms, as a smooth curve. The server steps at 60, 150 and
// 400 m; this ramps up just before each step, so a body crossing a boundary does not jump back in time.
export function intervalFor(d) {
  if (d < 40) return TICK_MS;
  if (d < 56) return TICK_MS + (d - 40) / 16 * TICK_MS;
  if (d < 115) return 2 * TICK_MS;
  if (d < 145) return 2 * TICK_MS + (d - 115) / 30 * 2 * TICK_MS;
  if (d < 320) return 4 * TICK_MS;
  if (d < 390) return 4 * TICK_MS + (d - 320) / 70 * 6 * TICK_MS;
  return 10 * TICK_MS;
}

export class Remote {
  constructor(id, kind, ef, name) {
    this.id = id; this.kind = kind; this.ef = ef; this.name = name;
    this.qx = 0; this.qy = 0; this.qz = 0; this.qyaw = 0; this.st = 0; this.gear = 0;   // the latest the server said, as sent
    this.aimYaw = 0; this.hurt = 0; this.hurtZone = 0; this.hurtYaw = 0;          // for drawing: which way they aim, how lately they were hit
    this.t = new Float64Array(N); this.p = new Float32Array(N * 4); this.m = new Uint8Array(N);
    this.head = -1; this.n = 0;
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;                        // where it is drawn this frame
    this.vx = 0; this.vz = 0;                                                // how fast it is drawn moving, for animation
    this.delay = 0; this.ival = TICK_MS; this.late = 0;
    this.owner = 0; this.mount = null;                                       // a horse's owner; a rider's horse while they are on it
    this.slot = -1;                                                          // for the renderer
  }
  // forget every sample: what comes next is somewhere else, not further along
  reset() { this.head = -1; this.n = 0; }
  get newest() { return this.head < 0 ? -Infinity : this.t[this.head]; }
  push(t, x, y, z, yaw, moving) {
    if (this.head >= 0 && t <= this.t[this.head]) { if (t < this.t[this.head]) return; }   // same instant: overwrite; older: ignore
    else { this.head = (this.head + 1) % N; if (this.n < N) this.n++; }
    const h = this.head, i = h * 4;
    this.t[h] = t; this.p[i] = x; this.p[i + 1] = y; this.p[i + 2] = z; this.p[i + 3] = yaw; this.m[h] = moving ? 1 : 0;
  }
  // place the entity where it was at server time rt
  sample(rt) {
    if (this.n === 0) return;
    const t = this.t, p = this.p;
    let h = this.head;
    if (rt >= t[h]) {                                                        // past the newest sample: the update is late
      const i = h * 4; let k = 0, j = -1;
      this.late = rt - t[h];
      if (this.m[h] && this.n > 1) { j = (h + N - 1) % N; const span = t[h] - t[j]; if (span > 0 && span <= 600) k = Math.min(this.late, EXTRAPOLATE_MS) / span; else j = -1; }
      if (j >= 0) {
        const q = j * 4;
        this.x = p[i] + (p[i] - p[q]) * k; this.y = p[i + 1] + (p[i + 1] - p[q + 1]) * k; this.z = p[i + 2] + (p[i + 2] - p[q + 2]) * k;
        const span = (t[h] - t[j]) / 1000; this.vx = (p[i] - p[q]) / span; this.vz = (p[i + 2] - p[q + 2]) / span;
      } else { this.x = p[i]; this.y = p[i + 1]; this.z = p[i + 2]; this.vx = 0; this.vz = 0; }
      this.yaw = p[i + 3];
      return;
    }
    this.late = 0;
    for (let c = 1; c < this.n; c++) {
      const j = (h + N - 1) % N;
      if (rt >= t[j]) {
        const span = t[h] - t[j], f = span > 0 ? (rt - t[j]) / span : 1, a = j * 4, b = h * 4;
        this.x = p[a] + (p[b] - p[a]) * f; this.y = p[a + 1] + (p[b + 1] - p[a + 1]) * f; this.z = p[a + 2] + (p[b + 2] - p[a + 2]) * f;
        this.yaw = lerpAng(p[a + 3], p[b + 3], f);
        if (span > 0) { this.vx = (p[b] - p[a]) / span * 1000; this.vz = (p[b + 2] - p[a + 2]) / span * 1000; }
        return;
      }
      h = j;
    }
    const i = h * 4;                                                         // older than everything kept
    this.x = p[i]; this.y = p[i + 1]; this.z = p[i + 2]; this.yaw = p[i + 3]; this.vx = 0; this.vz = 0;
  }
}
export const isMoving = st => (st & ST_MOVE) !== 0;
