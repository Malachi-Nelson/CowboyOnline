// A horse: one fixed 1/60 s step, like moveFoot.js, and under the same two rules (plain arithmetic only, state
// rounded to 32-bit floats) so the rider's browser and the server always agree where it is.
//
// A horse is not a fast pair of legs. It has a heading and goes where it is pointed; it comes round in an arc
// that widens with speed; it takes seconds to reach a gallop and seconds to stop. The numbers are the Phase 1
// feel targets:
//   gaits                          walk 1.7, trot 4.2, canter 7.5, gallop 13 m/s
//   standing start to a gallop     about 4 s
//   gallop to a stop, reined in    2.5 s and about 16 m
//   turning circle                 2 m at a walk, 8 m at a canter, 18 m at a gallop
//   a gallop lasts                 about 30 s, then the horse is winded and must get its breath back
//   a 20 degree climb              costs a third of the speed
import { SIM_DT, WORLD_SIZE } from '../constants.js';
import { SIN16, COS16, sinSmall, cosSmall } from './trig.js';
import { BTN, FOOT } from './moveFoot.js';

export const HORSE = {
  r: 0.45, len: 0.75,                    // two circles, one this far ahead of the middle and one behind
  h: 1.65, step: 0.5, seat: 1.42,        // seat: how high the saddle is above the hooves
  walk: 1.7, trot: 4.2, canter: 7.5, gallop: 13,
  accel: 3.25, coast: 3, rein: 5.2, back: 1.4,
  gallopFor: 30, breath: 0.3,            // seconds of gallop in a fresh horse; how full it must be again before it will gallop
  uphill: 0.915, steep: 0.78,            // 38 degrees is as steep as a horse will climb
  wade: 0.6, swimAt: 1.45, swim: 2.4,
  gravity: 20,
  reach: 2.6, mountSpeed: 3.5,           // how near, and how slow the horse must be, to get into the saddle
  far: 85, bringIn: 55, arrive: 2.4, comeFor: 30 * 60,   // whistle: beyond `far` the horse is brought in to `bringIn` first
};
export const HMODE = { IDLE: 0, COME: 1 };
// how fast the heading can swing (rad/s) at a given speed: speed / rate is the turning circle's radius
const TURN = [0, 2, 1.7, 1, 4.2, 0.98, 7.5, 0.94, 13, 0.72];
function turnRate(sp) {
  if (sp >= 13) return 0.72;
  let i = 2; while (sp > TURN[i]) i += 2;
  return TURN[i - 1] + (TURN[i + 1] - TURN[i - 1]) * (sp - TURN[i - 2]) / (TURN[i] - TURN[i - 2]);
}

export function makeHorse(x = 0, y = 0, z = 0) { return { x, y, z, hx: 0, hz: -1, sp: 0, vy: 0, ground: 1, stam: 1, winded: 0, mode: 0, t: 0, st: 0, sd: 0 }; }
export function copyHorse(d, s) { d.x = s.x; d.y = s.y; d.z = s.z; d.hx = s.hx; d.hz = s.hz; d.sp = s.sp; d.vy = s.vy; d.ground = s.ground; d.stam = s.stam; d.winded = s.winded; d.mode = s.mode; d.t = s.t; d.st = s.st; d.sd = s.sd; return d; }
export const horseFlags = h => (h.ground ? 1 : 0) | (h.winded ? 2 : 0) | (h.mode << 2);

// swing the heading toward (wx, wz) by at most `lim` radians
function turn(h, wx, wz, lim) {
  const ca = cosSmall(lim);
  if (h.hx * wx + h.hz * wz >= ca) { h.hx = wx; h.hz = wz; return; }
  const sa = h.hx * wz - h.hz * wx >= 0 ? sinSmall(lim) : -sinSmall(lim), nx = h.hx * ca - h.hz * sa;
  h.hz = h.hx * sa + h.hz * ca; h.hx = nx;
}

// The mover under every horse, ridden or not. (wx, wz): the way it is asked to go, a unit vector, or 0, 0 for
// nowhere. want: the speed asked for (negative backs up). rein: pull up hard. gallop: want is a gallop. slow: how
// hard it slows when it is going faster than asked.
function move(h, wx, wz, want, rein, gallop, field, slow = HORSE.coast) {
  const K = HORSE, dt = SIM_DT, T = field.terrain;
  const wet = T.levelAt(h.x, h.z) - h.y, swim = wet >= K.swimAt - 0.05;
  let gx = 0, gz = 0, sp = h.sp;
  if (h.ground && !swim && h.y - T.heightAt(h.x, h.z) < 0.06) { gx = T.heightAt(h.x + 0.5, h.z) - T.heightAt(h.x - 0.5, h.z); gz = T.heightAt(h.x, h.z + 0.5) - T.heightAt(h.x, h.z - 0.5); }

  if (h.ground) {
    if (want > 0) {
      const dot = h.hx * wx + h.hz * wz, a = sp < 0 ? -sp : sp;
      turn(h, wx, wz, turnRate(a) * dt);
      if (dot < -0.4) { if (want > K.walk) want = K.walk; } else if (dot < 0.3) { if (want > K.trot) want = K.trot; }   // a horse does not canter sideways: it slows to come round
      const grade = h.hx * gx + h.hz * gz;
      if (grade > 0) want *= 1 - (grade * K.uphill > 0.6 ? 0.6 : grade * K.uphill);
      if (swim) { if (want > K.swim) want = K.swim; }
      else if (wet > K.wade) want *= 1 - 0.45 * (wet > 1.4 ? 1 : (wet - K.wade) / (1.4 - K.wade));
    }
    if ((swim || wet > K.wade) && slow < 8) slow = 8;          // water drags
    if (rein) { if (sp > 0) { sp -= K.rein * dt; if (sp < 0) sp = 0; } else if (sp < 0) { sp += K.rein * dt; if (sp > 0) sp = 0; } }
    else if (sp < want) { sp += K.accel * dt; if (sp > want) sp = want; }
    else if (sp > want) { sp -= (want < 0 ? K.rein : slow) * dt; if (sp < want) sp = want; }
  }
  // wind: a gallop spends it, anything slower gives it back, fastest standing
  if (gallop && sp > K.canter + 0.5) { h.stam -= dt / K.gallopFor; if (h.stam <= 0) { h.stam = 0; h.winded = 1; } }
  else if (h.stam < 1) { h.stam += dt / (sp > 2 ? 20 : 12); if (h.stam > 1) h.stam = 1; if (h.winded && h.stam >= K.breath) h.winded = 0; }

  let dx = h.hx * sp * dt, dz = h.hz * sp * dt;
  const g2 = gx * gx + gz * gz;
  if (g2 > K.steep * K.steep) {                                 // too steep: it will go along the slope or down it, not up
    const up = dx * gx + dz * gz;
    if (up > 0) { dx -= gx * up / g2; dz -= gz * up / g2; sp -= sp * 4 * dt; }
  }
  let nx = h.x + dx, nz = h.z + dz, hit = 0, pnx = 0, pnz = 0;
  const bx = field.boxes, tr = field.trees, ya = h.y + K.step + 0.001, yb = h.y + K.h;
  for (let k = 1; k >= -1; k -= 2) {                            // forequarters, then hindquarters
    const cx = nx + h.hx * K.len * k, cz = nz + h.hz * K.len * k;
    if (bx.pushOut(cx, cz, K.r, ya, yb)) { nx += bx.x - cx; nz += bx.z - cz; if (k > 0) { hit = 1; pnx = bx.nx; pnz = bx.nz; } }
    const ex = nx + h.hx * K.len * k, ez = nz + h.hz * K.len * k;
    if (tr.pushOut(ex, ez, K.r)) { nx += tr.x - ex; nz += tr.z - ez; if (k > 0) { hit = 1; pnx = tr.nx; pnz = tr.nz; } }
  }
  if (hit) {                                                    // met something head on: pull up, and turn along it
    const into = h.hx * pnx + h.hz * pnz;
    if (into < 0 && sp > 0) {
      if (into < -0.7) { sp -= 30 * dt; if (sp < 0) sp = 0; }
      turn(h, pnx, pnz, 1.6 * dt);
    }
  }
  const lim = WORLD_SIZE - 4;
  nx = nx < 4 ? 4 : nx > lim ? lim : nx; nz = nz < 4 ? 4 : nz > lim ? lim : nz;

  let g = field.groundAt(nx, nz, h.y, K.step); const fl = T.levelAt(nx, nz) - K.swimAt;
  if (fl > g) g = fl;
  h.x = nx; h.z = nz;
  if (h.ground) { if (h.y - g <= K.step + 0.4) { h.y = g; h.vy = 0; } else h.ground = 0; }
  if (!h.ground) { h.vy -= K.gravity * dt; const ny = h.y + h.vy * dt; if (ny <= g) { h.y = g; h.vy = 0; h.ground = 1; } else h.y = ny; }

  const l = Math.sqrt(h.hx * h.hx + h.hz * h.hz), f = Math.fround;
  h.x = f(h.x); h.y = f(h.y); h.z = f(h.z); h.hx = f(h.hx / l); h.hz = f(h.hz / l); h.sp = f(sp); h.vy = f(h.vy); h.stam = f(h.stam);
}

// With a rider: the stick says where to go, as seen from the camera, and the horse comes round to it. Pulling
// straight back reins it in, and backs it up once it has stopped.
export function rideHorse(h, cmd, field) {
  const K = HORSE, btn = cmd.buttons, fwd = cmd.mz / 127, str = cmd.mx / 127, ml = Math.sqrt(fwd * fwd + str * str);
  if (ml <= 0.05) { move(h, 0, 0, 0, false, false, field); return; }
  const sn = SIN16[cmd.yaw & 65535], cs = COS16[cmd.yaw & 65535], k = 1 / ml, wx = (-sn * fwd + cs * str) * k, wz = (-cs * fwd - sn * str) * k;
  if (fwd < -0.5 && h.hx * wx + h.hz * wz < -0.7) {
    if (h.sp > 0.05) move(h, 0, 0, 0, true, false, field); else move(h, 0, 0, -K.back, false, false, field);
    return;
  }
  const gallop = (btn & BTN.SPRINT) !== 0 && !h.winded;
  move(h, wx, wz, (gallop ? K.gallop : (btn & BTN.WALK) ? K.trot : K.canter) * (ml < 1 ? ml : 1), false, gallop, field);
}

// Put the horse somewhere near its owner, out of sight if there is such a place: first choice is straight behind
// the owner's view, then round to either side. Used when it is called from too far away to run all the way.
function bringIn(h, f, yaw, dist, field) {
  const K = HORSE, T = field.terrain, lim = WORLD_SIZE - 12;
  for (let ring = 0; ring < 3; ring++, dist *= 0.5) {
    for (let k = 0; k < 8; k++) {
      const a = (yaw + 32768 + (k & 1 ? 1 : -1) * ((k + 1) >> 1) * 8192) & 65535, x = f.x - SIN16[a] * dist, z = f.z - COS16[a] * dist;
      if (x < 12 || z < 12 || x > lim || z > lim) continue;
      const y = T.heightAt(x, z), dy = y - f.y;
      if (T.levelAt(x, z) - y > 0.5 || dy > 25 || dy < -25) continue;
      const gx = T.heightAt(x + 1, z) - T.heightAt(x - 1, z), gz = T.heightAt(x, z + 1) - T.heightAt(x, z - 1);
      if (gx * gx + gz * gz > 1.6) continue;
      if (field.boxes.pushOut(x, z, 1.3, y + 0.5, y + K.h) || field.trees.pushOut(x, z, 1.3)) continue;
      const dx = f.x - x, dz = f.z - z, l = Math.sqrt(dx * dx + dz * dz) || 1;
      // and a clear run from there: nothing built in the way, and no deep water
      if (field.boxes.ray(x, y + 1, z, dx / l, 0, dz / l, l) < l) continue;
      let deep = false; for (let s = 6; s < l; s += 6) { const px = x + dx / l * s, pz = z + dz / l * s; if (T.levelAt(px, pz) - T.heightAt(px, pz) > 1) { deep = true; break; } }
      if (deep) continue;
      h.x = x; h.y = y; h.z = z; h.hx = dx / l; h.hz = dz / l; h.sp = l > 20 ? K.canter : K.trot; h.vy = 0; h.ground = 1;
      return;
    }
  }
  h.x = f.x; h.y = f.y; h.z = f.z; h.sp = 0; h.vy = 0;          // nowhere clear: it turns up at its owner's shoulder
}

// Without a rider. Called to, it runs to its owner and stops beside them; otherwise it comes to rest and stands.
export function freeHorse(h, f, cmd, field) {
  const K = HORSE;
  if (h.mode === HMODE.COME) {
    let dx = f.x - h.x, dz = f.z - h.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d < K.arrive || ++h.t > K.comeFor) h.mode = HMODE.IDLE;
    else {
      // too far to run, or getting nowhere (a river, a wall, a cliff in the way): start again from somewhere nearer
      let stuck = false;
      if (++h.st >= 90) { stuck = h.sd - d < 1.5 && d > 6; h.st = 0; h.sd = Math.fround(d); }
      if (d > K.far || stuck) {
        bringIn(h, f, cmd.yaw, stuck ? 16 : K.bringIn, field);
        dx = f.x - h.x; dz = f.z - h.z; d = Math.sqrt(dx * dx + dz * dz); h.st = 0; h.sd = Math.fround(d);
      }
      if (d > 0.01) { const want = d > 24 ? 12 : d > 9.5 ? K.canter : d > 4.5 ? K.trot : K.walk; move(h, dx / d, dz / d, want, false, false, field, K.rein); return; }
    }
  }
  if (h.sp !== 0 || !h.ground || h.stam < 1) move(h, 0, 0, 0, false, false, field);
}

export const horseNear = (h, f) => { const dx = f.x - h.x, dz = f.z - h.z, dy = f.y - h.y; return dx * dx + dz * dz < HORSE.reach * HORSE.reach && dy < 1.6 && dy > -1.6; };

// Where a rider stepping down lands: the horse's left if there is room, else its right, else where it stands.
export function dismountSpot(h, field, out) {
  for (let side = 1; side >= -1; side -= 2) {
    const x = h.x + h.hz * 1.15 * side, z = h.z - h.hx * 1.15 * side;
    if (!field.boxes.pushOut(x, z, FOOT.r, h.y + FOOT.step, h.y + FOOT.h) && !field.trees.pushOut(x, z, FOOT.r)) { out.x = x; out.z = z; return out; }
  }
  out.x = h.x; out.z = h.z;
  return out;
}
