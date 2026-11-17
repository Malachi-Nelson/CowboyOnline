// Bots are players without a connection. Each one fills in the same input record a person's browser would send,
// and the world steps it through the same movement code. For Phase 2 they only wander: pick a spot near home, go
// there at a walk, a jog or a run, stand a while, pick another. Proper behaviour arrives with the AI in Phase 4.
import { TICK_RATE, WORLD_SIZE } from '../../../shared/constants.js';
import { TAU, yawOf } from '../../../shared/math.js';
import { BTN } from '../../../shared/sim/moveFoot.js';

const TICK_DT = 1 / TICK_RATE;

export class Bot {
  constructor(e, rand, home) {
    this.e = e; this.rand = rand; this.home = home;            // home: { x, z, r }
    this.cmd = { mx: 0, mz: 0, yaw: 0, buttons: 0 };
    this.tx = e.s.x; this.tz = e.s.z; this.until = 0; this.pace = 0;
    this.wait = rand() * 4;
  }
  think(t) {
    const s = this.e.s, c = this.cmd, r = this.rand;
    c.mx = 0; c.mz = 0; c.buttons = 0;
    if (this.wait > 0) { this.wait -= TICK_DT; return; }
    const dx = this.tx - s.x, dz = this.tz - s.z;
    if (dx * dx + dz * dz < 6.25 || t > this.until) {
      if (r() < 0.6) this.wait = 0.5 + r() * 5;
      const a = r() * TAU, d = Math.sqrt(r()) * this.home.r, lim = WORLD_SIZE - 40;
      this.tx = Math.min(lim, Math.max(40, this.home.x + Math.cos(a) * d));
      this.tz = Math.min(lim, Math.max(40, this.home.z + Math.sin(a) * d));
      this.until = t + 25 + r() * 35;
      const k = r(); this.pace = k < 0.2 ? BTN.WALK : k < 0.7 ? 0 : BTN.SPRINT;
      return;
    }
    const yaw = yawOf(dx, dz);
    c.yaw = Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
    c.mz = 127;
    c.buttons = this.pace | (r() < 0.003 ? BTN.JUMP : 0);
  }
}
