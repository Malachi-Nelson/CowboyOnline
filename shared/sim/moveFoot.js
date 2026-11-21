// Movement on foot: one fixed 1/60 s step per input. The browser runs this to predict, the server runs it to decide,
// and because both feed it the same quantised input they land in the same place.
//
// The feel this aims for is weight: a body builds speed, cannot turn on the spot at a run, and takes a stride or two
// to stop. The numbers are the Phase 1 "feel targets" and are meant to be tuned by hand:
//   standing start to a sprint     about 0.9 s
//   sprint to a stop               0.4 s and about 1.3 m
//   turning at a sprint            an arc of about 2 m radius
//
// Two rules keep every machine in step. The step uses only +, -, *, / and Math.sqrt (see trig.js), which give the
// same bits everywhere. And the state is rounded to 32-bit floats at the end of each step, which is exactly what
// a snapshot carries, so a client that is put right by the server holds the very same numbers the server does.
import { SIM_DT, WORLD_SIZE } from '../constants.js';
import { SIN16, COS16, sinSmall, cosSmall } from './trig.js';

export const FOOT = {
  r: 0.34, h: 1.78, step: 0.45,
  walk: 1.6, jog: 3.6, sprint: 6.5,      // m/s
  accel: 7.5,                            // m/s^2 while building speed
  decel: 16.25,                          // m/s^2 with no input: 6.5 m/s to rest in 0.4 s
  brake: 22,                             // m/s^2 when the stick is thrown the other way: plant, then go
  turnSlow: 12, turnFast: 3.5,           // rad/s the heading can swing, standing and at a sprint (6.5 / 3.5 = 1.86 m arc)
  gravity: 20, jump: 4.6, airAccel: 2,
  uphill: 0.9,                           // share of speed lost per metre climbed per metre run, capped at 60%
  steep: 1.1,                            // ground rising faster than this (about 48 degrees) cannot be climbed
  wade: 0.3, swimAt: 1.25, swim: 1.7,    // water over the shins slows a body; at chest height it floats and swims
};
// buttons, 16 bits on the wire. Bits 10 and 11 are not a button but the gun the player wants in hand (guns.js).
export const BTN = { SPRINT: 1, JUMP: 2, WALK: 4, USE: 8, WHISTLE: 16, AIM: 32, FIRE: 64, RELOAD: 128, FOCUS: 256, HANDS: 512 };
export const BTN_MASK = 0x0fff;
export const FLAG = { GROUND: 1, JUMP_HELD: 2 };

export function makeFoot(x = 0, y = 0, z = 0) { return { x, y, z, vx: 0, vy: 0, vz: 0, ground: 1, jumpHeld: 0 }; }
export function copyFoot(d, s) { d.x = s.x; d.y = s.y; d.z = s.z; d.vx = s.vx; d.vy = s.vy; d.vz = s.vz; d.ground = s.ground; d.jumpHeld = s.jumpHeld; return d; }
export const footFlags = s => (s.ground ? FLAG.GROUND : 0) | (s.jumpHeld ? FLAG.JUMP_HELD : 0);

// cmd: { mx, mz: -127..127 (strafe right, forward), yaw: 0..65535 (view direction), buttons }
// field: { terrain: heightAt, levelAt; boxes; trees; groundAt(x, z, feet) }
export function stepFoot(s, cmd, field) {
  const F = FOOT, dt = SIM_DT, btn = cmd.buttons, T = field.terrain;
  const fwd = cmd.mz / 127, str = cmd.mx / 127, ml = Math.sqrt(fwd * fwd + str * str);
  const wet = T.levelAt(s.x, s.z) - s.y, swim = wet >= F.swimAt - 0.05;       // how far under the surface the feet are
  let wx = 0, wz = 0, wish = 0;
  if (ml > 0.05) {
    const sn = SIN16[cmd.yaw & 65535], cs = COS16[cmd.yaw & 65535], k = 1 / ml;
    wx = (-sn * fwd + cs * str) * k; wz = (-cs * fwd - sn * str) * k;
    wish = ((btn & BTN.SPRINT) && fwd > 0.5 ? F.sprint : (btn & BTN.WALK) ? F.walk : F.jog) * (ml < 1 ? ml : 1);
    if (swim) { if (wish > F.swim) wish = F.swim; }
    else if (wet > F.wade) wish *= 1 - 0.5 * (wet > 1 ? 1 : (wet - F.wade) / (1 - F.wade));
  }
  let sp = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
  // the slope underfoot, in metres of rise per metre; none when standing on something built, or afloat
  let gx = 0, gz = 0;
  if (s.ground && !swim && s.y - T.heightAt(s.x, s.z) < 0.06) { gx = T.heightAt(s.x + 0.5, s.z) - T.heightAt(s.x - 0.5, s.z); gz = T.heightAt(s.x, s.z + 0.5) - T.heightAt(s.x, s.z - 0.5); }

  if (s.ground) {
    if (wish > 0) {
      let hx = wx, hz = wz;                                    // from rest the body goes where it is told
      if (sp > 0.3) { hx = s.vx / sp; hz = s.vz / sp; }        // at speed it has a heading of its own
      const dot = hx * wx + hz * wz;
      if (dot < -0.5 && sp > 1.5) sp -= F.brake * dt;          // asked to reverse: brake first
      else {
        const grade = hx * gx + hz * gz;
        if (grade > 0) wish *= 1 - (grade * F.uphill > 0.6 ? 0.6 : grade * F.uphill);
        // swing the heading toward where it is told to go, by no more than the turn rate allows
        const lim = (F.turnSlow + (F.turnFast - F.turnSlow) * (sp >= F.sprint ? 1 : sp / F.sprint)) * dt, ca = cosSmall(lim);
        if (dot >= ca) { hx = wx; hz = wz; }
        else { const sa = hx * wz - hz * wx >= 0 ? sinSmall(lim) : -sinSmall(lim), nx = hx * ca - hz * sa; hz = hx * sa + hz * ca; hx = nx; }
        if (sp < wish) { sp += F.accel * dt; if (sp > wish) sp = wish; }
        else if (sp > wish) { sp -= F.decel * 0.5 * dt; if (sp < wish) sp = wish; }
      }
      s.vx = hx * sp; s.vz = hz * sp;
    } else if (sp > 0) {
      const ns = sp - F.decel * dt;
      if (ns <= 0) { s.vx = 0; s.vz = 0; } else { s.vx *= ns / sp; s.vz *= ns / sp; }
    }
    // too steep to climb: movement up the slope is taken away; along it and down it is left
    const g2 = gx * gx + gz * gz;
    if (g2 > F.steep * F.steep) { const up = s.vx * gx + s.vz * gz; if (up > 0) { s.vx -= gx * up / g2; s.vz -= gz * up / g2; } }
    const j = btn & BTN.JUMP;
    if (j && !s.jumpHeld && !swim) { s.vy = F.jump; s.ground = 0; }
    s.jumpHeld = j ? 1 : 0;
  } else {
    if (wish > 0) {                                            // a little steering in the air, never more speed
      s.vx += wx * F.airAccel * dt; s.vz += wz * F.airAccel * dt;
      const a = Math.sqrt(s.vx * s.vx + s.vz * s.vz), cap = sp > F.jog ? sp : F.jog;
      if (a > cap) { s.vx *= cap / a; s.vz *= cap / a; }
    }
    s.jumpHeld = (btn & BTN.JUMP) ? 1 : 0;
  }

  // across the ground, sliding along anything solid
  let nx = s.x + s.vx * dt, nz = s.z + s.vz * dt;
  const bx = field.boxes, tr = field.trees;
  if (bx.pushOut(nx, nz, F.r, s.y + F.step + 0.001, s.y + F.h - 0.05)) {
    nx = bx.x; nz = bx.z;
    const vn = s.vx * bx.nx + s.vz * bx.nz;
    if (vn < 0) { s.vx -= bx.nx * vn; s.vz -= bx.nz * vn; }
  }
  if (tr.pushOut(nx, nz, F.r)) {
    nx = tr.x; nz = tr.z;
    const vn = s.vx * tr.nx + s.vz * tr.nz;
    if (vn < 0) { s.vx -= tr.nx * vn; s.vz -= tr.nz * vn; }
  }
  const lim = WORLD_SIZE - 4;
  nx = nx < 4 ? 4 : nx > lim ? lim : nx; nz = nz < 4 ? 4 : nz > lim ? lim : nz;

  // up and down. Deep water holds a body up by the chest.
  let g = field.groundAt(nx, nz, s.y), fl = T.levelAt(nx, nz) - F.swimAt;
  if (fl > g) g = fl;
  if (!s.ground && g - s.y > F.step) {                         // a jump does not carry a body up a cliff
    nx = s.x; nz = s.z; s.vx = 0; s.vz = 0;
    g = field.groundAt(nx, nz, s.y); fl = T.levelAt(nx, nz) - F.swimAt; if (fl > g) g = fl;
  }
  s.x = nx; s.z = nz;
  if (s.ground) {
    if (s.y - g <= F.step + 0.35) { s.y = g; s.vy = 0; }       // up a step, or down a slope
    else s.ground = 0;                                          // off an edge
  }
  if (!s.ground) {
    s.vy -= F.gravity * dt;
    const ny = s.y + s.vy * dt;
    if (ny <= g) { s.y = g; s.vy = 0; s.ground = 1; } else s.y = ny;
  }
  const f = Math.fround;
  s.x = f(s.x); s.y = f(s.y); s.z = f(s.z); s.vx = f(s.vx); s.vy = f(s.vy); s.vz = f(s.vz);
}
