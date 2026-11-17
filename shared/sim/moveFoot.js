// Movement on foot: one fixed 1/60 s step per input. The browser runs this to predict, the server runs it to decide,
// and because both feed it the same quantised input they land in the same place.
//
// The feel this aims for is weight: a body builds speed, cannot turn on the spot at a run, and takes a stride or two
// to stop. The numbers are the Phase 1 "feel targets" and are meant to be tuned by hand:
//   standing start to a sprint     about 0.9 s
//   sprint to a stop               0.4 s and about 1.3 m
//   turning at a sprint            an arc of about 2 m radius
import { SIM_DT, WORLD_SIZE } from '../constants.js';
import { TAU } from '../math.js';

export const FOOT = {
  r: 0.34, h: 1.78, step: 0.45,
  walk: 1.6, jog: 3.6, sprint: 6.5,      // m/s
  accel: 7.5,                            // m/s^2 while building speed
  decel: 16.25,                          // m/s^2 with no input: 6.5 m/s to rest in 0.4 s
  brake: 22,                             // m/s^2 when the stick is thrown the other way: plant, then go
  turnSlow: 12, turnFast: 3.5,           // rad/s the heading can swing, standing and at a sprint (6.5 / 3.5 = 1.86 m arc)
  gravity: 20, jump: 4.6, airAccel: 2,
  uphill: 0.9,                           // share of speed lost per metre climbed per metre run, capped at 60%
};
export const BTN = { SPRINT: 1, JUMP: 2, WALK: 4 };
export const FLAG = { GROUND: 1, JUMP_HELD: 2 };

export function makeFoot(x = 0, y = 0, z = 0) { return { x, y, z, vx: 0, vy: 0, vz: 0, ground: 1, jumpHeld: 0 }; }
export function copyFoot(d, s) { d.x = s.x; d.y = s.y; d.z = s.z; d.vx = s.vx; d.vy = s.vy; d.vz = s.vz; d.ground = s.ground; d.jumpHeld = s.jumpHeld; return d; }
export const footFlags = s => (s.ground ? FLAG.GROUND : 0) | (s.jumpHeld ? FLAG.JUMP_HELD : 0);

// cmd: { mx, mz: -127..127 (strafe right, forward), yaw: 0..65535 (view direction), buttons }
// field: { terrain.heightAt(x, z), boxes (BoxWorld), groundAt(x, z, feet) }
export function stepFoot(s, cmd, field) {
  const F = FOOT, dt = SIM_DT, btn = cmd.buttons;
  const fwd = cmd.mz / 127, str = cmd.mx / 127, ml = Math.sqrt(fwd * fwd + str * str);
  let wx = 0, wz = 0, wish = 0;
  if (ml > 0.05) {
    const yaw = cmd.yaw * (TAU / 65536), sn = Math.sin(yaw), cs = Math.cos(yaw), k = 1 / ml;
    wx = (-sn * fwd + cs * str) * k; wz = (-cs * fwd - sn * str) * k;
    wish = ((btn & BTN.SPRINT) && fwd > 0.5 ? F.sprint : (btn & BTN.WALK) ? F.walk : F.jog) * (ml < 1 ? ml : 1);
  }
  let sp = Math.sqrt(s.vx * s.vx + s.vz * s.vz);

  if (s.ground) {
    if (wish > 0) {
      let hx = wx, hz = wz;                                    // from rest the body goes where it is told
      if (sp > 0.3) { hx = s.vx / sp; hz = s.vz / sp; }        // at speed it has a heading of its own
      const dot = hx * wx + hz * wz;
      if (dot < -0.5 && sp > 1.5) sp -= F.brake * dt;          // asked to reverse: brake first
      else {
        const grade = field.terrain.heightAt(s.x + hx, s.z + hz) - field.terrain.heightAt(s.x, s.z);
        if (grade > 0) wish *= 1 - (grade * F.uphill > 0.6 ? 0.6 : grade * F.uphill);
        const ang = Math.atan2(hx * wz - hz * wx, dot);
        const lim = (F.turnSlow + (F.turnFast - F.turnSlow) * (sp >= F.sprint ? 1 : sp / F.sprint)) * dt;
        const a = ang > lim ? lim : ang < -lim ? -lim : ang, ca = Math.cos(a), sa = Math.sin(a);
        const nx = hx * ca - hz * sa, nz = hx * sa + hz * ca;
        hx = nx; hz = nz;
        if (sp < wish) { sp += F.accel * dt; if (sp > wish) sp = wish; }
        else if (sp > wish) { sp -= F.decel * 0.5 * dt; if (sp < wish) sp = wish; }
      }
      s.vx = hx * sp; s.vz = hz * sp;
    } else if (sp > 0) {
      const ns = sp - F.decel * dt;
      if (ns <= 0) { s.vx = 0; s.vz = 0; } else { s.vx *= ns / sp; s.vz *= ns / sp; }
    }
    const j = btn & BTN.JUMP;
    if (j && !s.jumpHeld) { s.vy = F.jump; s.ground = 0; }
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
  const bx = field.boxes;
  if (bx.pushOut(nx, nz, F.r, s.y + F.step + 0.001, s.y + F.h - 0.05)) {
    nx = bx.x; nz = bx.z;
    const vn = s.vx * bx.nx + s.vz * bx.nz;
    if (vn < 0) { s.vx -= bx.nx * vn; s.vz -= bx.nz * vn; }
  }
  const lim = WORLD_SIZE - 4;
  s.x = nx < 4 ? 4 : nx > lim ? lim : nx;
  s.z = nz < 4 ? 4 : nz > lim ? lim : nz;

  // up and down
  const g = field.groundAt(s.x, s.z, s.y);
  if (s.ground) {
    if (s.y - g <= F.step + 0.35) { s.y = g; s.vy = 0; }       // up a step, or down a slope
    else s.ground = 0;                                          // off an edge
  }
  if (!s.ground) {
    s.vy -= F.gravity * dt;
    const ny = s.y + s.vy * dt;
    if (ny <= g) { s.y = g; s.vy = 0; s.ground = 1; } else s.y = ny;
  }
}
