// Bots are players without a connection. Each one fills in the same input record a person's browser would send,
// and the world steps it through the same movement code, horse and all. Three kinds for now:
//   townsfolk   on foot, drifting between spots on the streets of the place they live in
//   riders      on the roads between places; at the end of one they step down, stretch their legs, whistle the
//               horse back and ride on
//   wanderers   scattered over open country, for load tests
// What they do is only enough to make the territory look lived in. Proper behaviour arrives with the AI in Phase 4.
import { TICK_RATE, WORLD_SIZE } from '../../../shared/constants.js';
import { TAU, yawOf } from '../../../shared/math.js';
import { BTN } from '../../../shared/sim/moveFoot.js';
import { horseNear, HORSE } from '../../../shared/sim/moveHorse.js';

const DT = 1 / TICK_RATE;
const yaw16 = (dx, dz) => Math.round((((yawOf(dx, dz) % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
const dry = (field, x, z) => field.terrain.levelAt(x, z) - field.terrain.heightAt(x, z) < 0.4;

export class Bot {
  // role: 'town' | 'rider' | 'wander'. home: { x, z, r } for wanderers, a place id for townsfolk
  constructor(e, rand, role, field, home) {
    this.e = e; this.rand = rand; this.role = role; this.field = field; this.home = home;
    this.cmd = { mx: 0, mz: 0, yaw: 0, buttons: 0 };
    this.tx = e.s.x; this.tz = e.s.z; this.pace = 0; this.wait = rand() * 4; this.until = 0;
    this.lx = e.s.x; this.lz = e.s.z; this.checkAt = 0; this.slow = 0;
    this.road = null; this.ri = 0; this.dir = 1; this.mode = role === 'rider' ? 'ride' : 'walk'; this.pressed = false; this.timer = 0;
    if (role === 'rider') this.pickRoad(null);
  }
  // a spot on one of the streets of the bot's own place
  streetPoint() {
    const S = this.field.streets.filter(s => s.place === this.home), r = this.rand;
    if (!S.length) return;
    const s = S[(r() * r() * S.length) | 0];                     // the first street of a place is its main one, and the busiest
    this.tx = s.x0 + r() * (s.x1 - s.x0); this.tz = s.z0 + r() * (s.z1 - s.z0);
  }
  // choose a road to follow from where the bot is: the nearest end of any road, other than the one just ridden
  pickRoad(prev) {
    const roads = this.field.terrain.roads, s = this.e.s; let best = null, bd = 1e9, end = 0;
    const opts = [];
    for (const rd of roads) for (const at of [0, rd.n - 1]) {
      const d = Math.hypot(rd.x[at] - s.x, rd.z[at] - s.z);
      if (d < 130 && rd !== prev) opts.push([rd, at]);
      if (d < bd) { bd = d; best = rd; end = at; }
    }
    if (opts.length) { const o = opts[(this.rand() * opts.length) | 0]; best = o[0]; end = o[1]; }
    this.road = best; this.dir = end === 0 ? 1 : -1; this.ri = end;
    const k = this.rand(); this.pace = k < 0.55 ? BTN.WALK : k < 0.93 ? 0 : BTN.SPRINT;        // trot, canter, now and then a gallop
  }
  // start somewhere along a road rather than at its end, so riders are spread over the country from the first tick
  startOnRoad(rd, at, dir) { this.road = rd; this.ri = at; this.dir = dir; }

  think(t) {
    const e = this.e, s = e.s, a = e.a, c = this.cmd, r = this.rand;
    c.mx = 0; c.mz = 0; c.buttons = 0;
    if (this.pressed) { this.pressed = false; return; }           // let go of the key for a tick, so the next press is a new one
    if (this.wait > 0) { this.wait -= DT; return; }

    // going nowhere for two seconds while trying to: something is in the way, so think again
    if (t >= this.checkAt) {
      const moved = Math.hypot(s.x - this.lx, s.z - this.lz);
      this.slow = moved < 0.7 ? this.slow + 1 : 0; this.lx = s.x; this.lz = s.z; this.checkAt = t + 1;
    }

    if (this.role === 'rider') return this.rider(t);
    const dx = this.tx - s.x, dz = this.tz - s.z;
    if (dx * dx + dz * dz < 2.5 || t > this.until || this.slow >= 2) {
      this.slow = 0;
      if (r() < 0.65) this.wait = 1 + r() * 9;
      if (this.role === 'town') { this.streetPoint(); const k = r(); this.pace = k < 0.72 ? BTN.WALK : k < 0.96 ? 0 : BTN.SPRINT; }
      else {
        for (let i = 0; i < 6; i++) { const ang = r() * TAU, d = Math.sqrt(r()) * this.home.r, lim = WORLD_SIZE - 40; this.tx = Math.min(lim, Math.max(40, this.home.x + Math.cos(ang) * d)); this.tz = Math.min(lim, Math.max(40, this.home.z + Math.sin(ang) * d)); if (dry(this.field, this.tx, this.tz)) break; }
        const k = r(); this.pace = k < 0.2 ? BTN.WALK : k < 0.7 ? 0 : BTN.SPRINT;
      }
      this.until = t + 25 + r() * 35;
      return;
    }
    c.yaw = yaw16(dx, dz); c.mz = 127;
    c.buttons = this.pace | (this.role === 'wander' && r() < 0.003 ? BTN.JUMP : 0);
  }

  rider(t) {
    const e = this.e, s = e.s, a = e.a, c = this.cmd, r = this.rand, h = a.h;
    const press = b => { c.buttons |= b; this.pressed = true; };
    if (this.mode === 'ride') {
      if (!a.riding) { this.mode = 'call'; this.timer = 0; return; }
      const rd = this.road; let dx = rd.x[this.ri] - s.x, dz = rd.z[this.ri] - s.z;
      while (dx * dx + dz * dz < 100) {                           // within 10 m of the point ahead: aim at the next
        const ni = this.ri + this.dir * 3;
        if (ni < 0 || ni >= rd.n) {                               // the end of the road
          if (r() < 0.6) { this.mode = 'stop'; return; }
          this.pickRoad(rd); return;
        }
        this.ri = ni; dx = rd.x[ni] - s.x; dz = rd.z[ni] - s.z;
      }
      if (this.slow >= 3) { this.slow = 0; this.ri = Math.max(0, Math.min(rd.n - 1, this.ri + this.dir * 3)); }
      c.yaw = yaw16(dx, dz); c.mz = 127; c.buttons = this.pace;
    } else if (this.mode === 'stop') {                            // rein in, then step down
      if (h.sp > 0.6) return;
      if (a.riding) { press(BTN.USE); return; }
      this.mode = 'stroll'; this.timer = 6 + r() * 20;
      const ang = r() * TAU, d = 4 + r() * 10; this.tx = s.x + Math.cos(ang) * d; this.tz = s.z + Math.sin(ang) * d; this.wait = 0.5 + r();
    } else if (this.mode === 'stroll') {
      this.timer -= DT;
      const dx = this.tx - s.x, dz = this.tz - s.z;
      if (dx * dx + dz * dz > 2 && this.slow < 2) { c.yaw = yaw16(dx, dz); c.mz = 127; c.buttons = BTN.WALK; }
      if (this.timer <= 0) { this.mode = 'call'; this.timer = 0; }
    } else {                                                      // 'call': whistle, wait for the horse, mount
      if (a.riding) { this.mode = 'ride'; this.pickRoad(r() < 0.5 ? this.road : null); this.wait = 0.4; return; }
      if (horseNear(h, s) && h.sp < HORSE.mountSpeed) { press(BTN.USE); return; }
      this.timer -= DT;
      if (this.timer <= 0) { press(BTN.WHISTLE); this.timer = 9; }
    }
  }
}
