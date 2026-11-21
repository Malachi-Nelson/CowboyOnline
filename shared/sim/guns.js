// Guns, as part of the one step that moves a player (actor.js). Drawing, aiming, firing, the hammer or lever
// between shots, reloading round by round, the kick of each shot and the focus meter all live in here, under the
// same two rules as movement (plain arithmetic, state rounded to 32-bit floats), so a player's own browser shows a
// shot, an empty cylinder or a reload the moment the button goes down and the server agrees to the bit.
//
// What the step does not do is decide what a bullet hits. It leaves the shot it fired (where from, which way) on
// the actor; the server traces it against the world as the shooter saw it (lag compensation, server/src/core/
// combat.js), and the browser traces it against what it draws, for the flash and the puff of dust. So a client
// can fire no faster than its gun allows and can never say what it hit: it only says where it was pointing.
//
// The way a shot leaves the gun is the line through the middle of the screen. The camera sits behind and to the
// right of the player, and the shot starts on the same line (AIM below) and runs the way the view faces, nudged by
// the gun's spread. The spread is drawn from a hash of the shot count and the shooter's position, so it is the same
// on both sides and still different from shot to shot.
import { SIM_DT } from '../constants.js';
import { SIN16, COS16 } from './trig.js';
import { BTN } from './moveFoot.js';

const S = SIM_DT, RAD = 65536 / (Math.PI * 2);                  // radians to the 65,536 steps of a turn
export const GUN = { NONE: 0, REVOLVER: 1, REPEATER: 2 };
// steps are 1/60 s. spread is in radians: aimed, from the hip, added at a run, added in the saddle, added by each
// shot (and how fast that goes away, per second), and in focus
export const GUNS = [
  null,
  { id: 1, name: 'Sawback .44 revolver', short: 'Revolver', mag: 6, spare: 48, rate: 22, focusRate: 9, first: 30, each: 24,
    dmg: 34, near: 25, far: 70, farDmg: 0.5, range: 160, aim: 0.005, hip: 0.035, move: 0.018, ride: 0.022, kick: 0.022, settle: 0.11, focus: 0.0012 },
  { id: 2, name: 'Tolliver lever-action repeater', short: 'Repeater', mag: 14, spare: 70, rate: 33, focusRate: 16, first: 34, each: 21,
    dmg: 46, near: 60, far: 160, farDmg: 0.6, range: 300, aim: 0.0025, hip: 0.045, move: 0.022, ride: 0.028, kick: 0.03, settle: 0.09, focus: 0.0008 },
];
export const DRAW_STEPS = 24, HOLSTER_STEPS = 18;               // 0.4 s to draw, 0.3 s to put away
export const AIM_STEADY = 18;                                    // steps of aiming before the aimed spread is reached
export const FOCUS = { drain: 1 / 7, refill: 1 / 45, min: 0.08 }; // a full meter is 7 s of focus and refills in 45 s
// The shot's line. Head height and shoulder offset match the camera (client/src/player/camera.js reads these).
export const AIM = { head: 1.55, rideHead: 2.45, shoulder: 0.55, rideShoulder: 0.6, up: 0.15 };
export const GF = { FIRE_HELD: 1, RELOAD_HELD: 2, IN_FOCUS: 4, HANDS: 8 };
export const WEAPON_SHIFT = 10;
export const weaponOf = buttons => (buttons >> WEAPON_SHIFT) & 3;

export function gunFields(a) {
  a.slot = 0; a.swap = 0; a.swapTo = 0; a.cool = 0; a.rel = 0;
  a.m1 = GUNS[1].mag; a.m2 = GUNS[2].mag; a.r1 = GUNS[1].spare; a.r2 = GUNS[2].spare;
  a.shots = 0; a.aimT = 0; a.bloom = 0; a.focus = 1; a.gfl = 0; a.dead = 0; a.jail = 0;
  a.fired = 0; a.ox = 0; a.oy = 0; a.oz = 0; a.dx = 0; a.dy = 0; a.dz = -1;     // the shot made this step, if any (not state)
  return a;
}
export function copyGun(d, s) {
  d.slot = s.slot; d.swap = s.swap; d.swapTo = s.swapTo; d.cool = s.cool; d.rel = s.rel; d.m1 = s.m1; d.m2 = s.m2; d.r1 = s.r1; d.r2 = s.r2;
  d.shots = s.shots; d.aimT = s.aimT; d.bloom = s.bloom; d.focus = s.focus; d.gfl = s.gfl; d.dead = s.dead; d.jail = s.jail;
}
export const sameGun = (a, b) => a.slot === b.slot && a.swap === b.swap && a.swapTo === b.swapTo && a.cool === b.cool && a.rel === b.rel && a.m1 === b.m1 && a.m2 === b.m2 && a.r1 === b.r1 && a.r2 === b.r2 &&
  a.shots === b.shots && a.aimT === b.aimT && a.bloom === b.bloom && a.focus === b.focus && a.gfl === b.gfl && a.dead === b.dead && a.jail === b.jail;
export const magOf = a => (a.slot === 1 ? a.m1 : a.slot === 2 ? a.m2 : 0);
export const spareOf = a => (a.slot === 1 ? a.r1 : a.slot === 2 ? a.r2 : 0);
export const aiming = (a, cmd) => (cmd.buttons & BTN.AIM) !== 0 && a.slot !== 0 && a.swap === 0 && !a.dead;

// a hash of a few integers to 0..1
function hash3(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// The spread of the next shot, in radians: steadier the longer the player has been aiming, worse on the move, in the
// saddle, and right after another shot. speed: m/s over the ground.
export function spreadOf(a, G, aimed, speed) {
  let s;
  if (a.gfl & GF.IN_FOCUS) return G.focus;
  if (aimed) { const k = a.aimT >= AIM_STEADY ? 0 : (AIM_STEADY - a.aimT) / AIM_STEADY; s = G.aim * (1 + k * 1.5); }
  else s = G.hip;
  s += a.bloom;
  if (a.riding) s += G.ride * (speed > 2 ? 1 : 0.4);
  else if (speed > 0.5) s += G.move * (speed > 6 ? 1 : speed / 6);
  return s;
}

// One step of the gun hand. Called by stepActor after the body (or horse) has moved, so a shot leaves from where
// the player now is. speed: how fast the player is going, for the spread.
export function stepGun(a, cmd, speed) {
  a.fired = 0;
  const btn = cmd.buttons, f = a.f, r = Math.fround;
  if (a.dead) { a.gfl = 0; a.aimT = 0; a.rel = 0; a.swap = 0; a.slot = 0; return; }
  if (a.cool > 0) a.cool--;
  if (a.bloom > 0) { const G = GUNS[a.slot] || GUNS[1]; a.bloom = r(a.bloom - G.settle * S); if (a.bloom < 0) a.bloom = 0; }

  // hands up: only with nothing in hand and both feet on the ground
  const hands = (btn & BTN.HANDS) !== 0 && a.slot === 0 && a.swap === 0 && !a.riding && f.ground;
  // draw, put away, or change guns. The gun goes in the holster at once; the new one is in hand when the count runs out.
  let want = weaponOf(btn); if (want === 3) want = a.slot;
  if (a.jail || hands) want = 0;
  if (a.swap === 0 && want !== a.slot) { a.swapTo = want; a.swap = want === 0 ? HOLSTER_STEPS : DRAW_STEPS; a.slot = 0; a.rel = 0; a.aimT = 0; }
  if (a.swap > 0 && --a.swap === 0) a.slot = a.swapTo;

  const G = GUNS[a.slot], aimed = aiming(a, cmd);
  a.aimT = aimed ? (a.aimT < 60 ? a.aimT + 1 : 60) : 0;
  // focus: while the key is held and the gun is up, until the meter is spent; it fills again slowly when not in use
  const focusing = aimed && (btn & BTN.FOCUS) !== 0 && a.focus > 0 && (a.gfl & GF.IN_FOCUS || a.focus >= FOCUS.min);
  if (focusing) { a.focus = r(a.focus - FOCUS.drain * S); if (a.focus <= 0) a.focus = 0; }
  else if (a.focus < 1) { a.focus = r(a.focus + FOCUS.refill * S); if (a.focus > 1) a.focus = 1; }
  const prev = a.gfl, gfl = (focusing && a.focus > 0 ? GF.IN_FOCUS : 0) | (hands ? GF.HANDS : 0);

  const fire = (btn & BTN.FIRE) !== 0, reload = (btn & BTN.RELOAD) !== 0;
  if (G) {
    const mag = a.slot === 1 ? a.m1 : a.m2, spare = a.slot === 1 ? a.r1 : a.r2;
    // reloading, a round at a time; it starts on the key, or by itself when the trigger is pulled on an empty gun
    if (reload && !(prev & GF.RELOAD_HELD) && a.rel === 0 && mag < G.mag && spare > 0) a.rel = G.first;
    if (a.rel > 0 && --a.rel === 0) {
      if (a.slot === 1) { a.m1++; a.r1--; } else { a.m2++; a.r2--; }
      if (mag + 1 < G.mag && spare - 1 > 0) a.rel = G.each;
    }
    // a shot: on the trigger going down, with the hammer back, and a round in the chamber. Firing cuts a reload short.
    if (fire && !(prev & GF.FIRE_HELD) && a.cool === 0 && a.swap === 0) {
      const now = a.slot === 1 ? a.m1 : a.m2;
      if (now > 0) {
        if (a.slot === 1) a.m1--; else a.m2--;
        a.rel = 0; a.cool = gfl & GF.IN_FOCUS ? G.focusRate : G.rate; a.shots = (a.shots + 1) & 65535;
        shoot(a, cmd, G, spreadOf(a, G, aimed, speed));
        a.bloom = r(a.bloom + G.kick); a.fired = a.slot;
      } else {
        a.cool = 12;                                               // click: the hammer falls on nothing
        if (spare > 0 && a.rel === 0) a.rel = G.first;
      }
    }
  }
  a.gfl = gfl | (fire ? GF.FIRE_HELD : 0) | (reload ? GF.RELOAD_HELD : 0);
  if (!G) a.rel = 0;
}

// where the shot starts and which way it goes, into a.ox.. and a.dx..
function shoot(a, cmd, G, spread) {
  const f = a.f, yaw = cmd.yaw & 65535, riding = a.riding !== 0;
  const u = hash3(a.shots, Math.floor(f.x * 8), Math.floor(f.z * 8)), v = hash3(a.shots + 7919, Math.floor(f.z * 8), Math.floor(f.x * 8));
  const ang = Math.floor(u * 65536) & 65535, rr = Math.sqrt(v) * spread * RAD;
  const yi = (yaw + Math.round(rr * COS16[ang])) & 65535, pi = (pitchOf(cmd) + Math.round(rr * SIN16[ang])) & 65535;
  const cp = COS16[pi];
  a.dx = -SIN16[yi] * cp; a.dy = SIN16[pi]; a.dz = -COS16[yi] * cp;
  const sh = riding ? AIM.rideShoulder : AIM.shoulder, hd = (riding ? AIM.rideHead : AIM.head) + AIM.up;
  a.ox = f.x + COS16[yaw] * sh; a.oy = f.y + hd; a.oz = f.z - SIN16[yaw] * sh;
}
// the view's pitch as steps of a turn, limited to what the camera allows
export const PITCH_MAX = 14000;
export function pitchOf(cmd) { const p = cmd.pitch | 0; return p > PITCH_MAX ? PITCH_MAX : p < -PITCH_MAX ? -PITCH_MAX : p; }
// how far a shot does damage, as a share of full damage at distance d
export function falloff(G, d) { return d <= G.near ? 1 : d >= G.far ? G.farDmg : 1 - (1 - G.farDmg) * (d - G.near) / (G.far - G.near); }
