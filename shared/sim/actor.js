// A player, or a bot: a body on foot, the horse that belongs to it, and which of the two the controls are driving.
// stepActor is the one function that moves a player; the browser runs it to predict and the server runs it to
// decide. Whistling for the horse, getting into the saddle and stepping down all happen in here, so the player's
// own browser can show them the instant the key goes down instead of waiting on the server.
import { makeFoot, copyFoot, stepFoot, BTN, FOOT } from './moveFoot.js';
import { makeHorse, copyHorse, rideHorse, freeHorse, horseNear, dismountSpot, horseFlags, HORSE, HMODE } from './moveHorse.js';

export const WHISTLE_STEPS = 90;                  // 1.5 s before the next whistle
export const WHISTLE_HEARD = 60;                  // others hear it while the countdown is above this (half a second)
export const AF = { GROUND: 1, JUMP_HELD: 2, RIDING: 4, USE_HELD: 8, WH_HELD: 16, HAS_HORSE: 32, HORSE_BLOCK: 64 };
const spot = { x: 0, z: 0 };

export function makeActor(x = 0, y = 0, z = 0, horse = false) { return { f: makeFoot(x, y, z), h: horse ? makeHorse(x, y, z) : null, riding: 0, useHeld: 0, whHeld: 0, whT: 0 }; }
export function copyActor(d, s) {
  copyFoot(d.f, s.f); d.riding = s.riding; d.useHeld = s.useHeld; d.whHeld = s.whHeld; d.whT = s.whT;
  if (s.h) { if (!d.h) d.h = makeHorse(); copyHorse(d.h, s.h); } else d.h = null;
  return d;
}
export const actorFlags = a => (a.f.ground ? AF.GROUND : 0) | (a.f.jumpHeld ? AF.JUMP_HELD : 0) | (a.riding ? AF.RIDING : 0) | (a.useHeld ? AF.USE_HELD : 0) | (a.whHeld ? AF.WH_HELD : 0) | (a.h ? AF.HAS_HORSE : 0);

export function stepActor(a, cmd, field) {
  const btn = cmd.buttons, h = a.h, f = a.f, use = (btn & BTN.USE) !== 0, wh = (btn & BTN.WHISTLE) !== 0;
  if (a.whT > 0) a.whT--;
  if (wh && !a.whHeld && a.whT === 0) {
    a.whT = WHISTLE_STEPS;
    if (h && !a.riding) { h.mode = HMODE.COME; h.t = 0; h.st = 0; h.sd = 4096; }
  }
  if (h && use && !a.useHeld) {
    if (a.riding) {                                             // step down; a rider who leaves a moving horse keeps some of its speed
      dismountSpot(h, field, spot);
      const k = h.sp > FOOT.sprint ? FOOT.sprint : h.sp < 0 ? 0 : h.sp, r = Math.fround;
      f.x = r(spot.x); f.z = r(spot.z); f.y = h.y; f.vx = r(h.hx * k); f.vz = r(h.hz * k); f.vy = 0; f.ground = h.ground;
      a.riding = 0;
    } else if (horseNear(h, f) && h.sp < HORSE.mountSpeed && h.sp > -HORSE.mountSpeed) { a.riding = 1; h.mode = HMODE.IDLE; }
  }
  a.useHeld = use ? 1 : 0; a.whHeld = wh ? 1 : 0;
  if (a.riding) {
    rideHorse(h, cmd, field);
    f.x = h.x; f.y = h.y; f.z = h.z; f.vx = Math.fround(h.hx * h.sp); f.vy = h.vy; f.vz = Math.fround(h.hz * h.sp); f.ground = h.ground; f.jumpHeld = (btn & BTN.JUMP) ? 1 : 0;
  } else {
    stepFoot(f, cmd, field);
    if (h) freeHorse(h, f, cmd, field);
  }
}

// ---- an actor as a row of numbers, for the client's memory of what it predicted: 15 floats, 5 small integers
export const ROW_F = 15, ROW_B = 5;
export function packActor(a, F, o, B, p, T, q) {
  const f = a.f, h = a.h;
  F[o] = f.x; F[o + 1] = f.y; F[o + 2] = f.z; F[o + 3] = f.vx; F[o + 4] = f.vy; F[o + 5] = f.vz;
  B[p] = actorFlags(a); B[p + 1] = a.whT;
  if (h) { F[o + 6] = h.x; F[o + 7] = h.y; F[o + 8] = h.z; F[o + 9] = h.hx; F[o + 10] = h.hz; F[o + 11] = h.sp; F[o + 12] = h.vy; F[o + 13] = h.stam; F[o + 14] = h.sd; B[p + 2] = horseFlags(h); B[p + 3] = h.st; T[q] = h.t; }
}
// does the row match the actor? Positions may differ by dust (eps); everything else must be the same.
export function sameActor(a, F, o, B, p, T, q, eps) {
  const f = a.f, h = a.h, c = (i, v) => { const d = F[o + i] - v; return d <= eps && d >= -eps; };
  if (!(c(0, f.x) && c(1, f.y) && c(2, f.z) && c(3, f.vx) && c(4, f.vy) && c(5, f.vz)) || B[p] !== actorFlags(a) || B[p + 1] !== a.whT) return false;
  if (!h) return true;
  return c(6, h.x) && c(7, h.y) && c(8, h.z) && c(9, h.hx) && c(10, h.hz) && c(11, h.sp) && c(12, h.vy) && c(13, h.stam) && c(14, h.sd) && B[p + 2] === horseFlags(h) && B[p + 3] === h.st && T[q] === h.t;
}
