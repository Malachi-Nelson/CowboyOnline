// Every message on the wire, both directions. The first byte is the message type.
// docs/PROTOCOL.md describes the same layouts in words; change both together and bump PROTOCOL_VERSION.
import { PROTOCOL_VERSION, POS_Q, Y_Q, Y_OFF, KIND_HORSE } from '../constants.js';
import { AF, actorFlags } from '../sim/actor.js';
import { horseFlags, makeHorse } from '../sim/moveHorse.js';
import { TAU } from '../math.js';

export const MSG = { HELLO: 1, WELCOME: 2, INPUT: 3, SNAPSHOT: 4, PING: 5, PONG: 6, REJECT: 7 };
export const REJECT = { VERSION: 1, FULL: 2, BAD: 3 };
// update mask bits in a snapshot. PUT: the server put this body somewhere (getting up again, the cell), so there is
// no path between where it was and where it is; it carries no bytes of its own
export const UM = { POS: 1, YAW: 2, STATE: 4, GEAR: 8, PUT: 0x10, HOLD: 0x80 };
// things that happened, told to everyone who can see them: a shot (who, which way, how far it went and what it
// struck), a hit (who, where on the body, how hard, from which way), a death, and notes for one player only
export const EV = { SHOT: 1, HIT: 2, DIE: 3, NOTE: 4 };
export const ZONE = { NONE: 0, HEAD: 1, BODY: 2, LEGS: 3, HORSE: 4 };
export const STRUCK = { AIR: 0, GROUND: 1, WOOD: 2, TREE: 3, WATER: 4, BODY: 5, HORSE: 6 };
// notes: what the law knows, mostly
export const NOTE = { SEEN: 1, WITNESS: 2, REPORTED: 3, WANTED: 4, ESCAPED: 5, ARRESTED: 6, RELEASED: 7, LAW_SEES: 8, LOST_THEM: 9, KILLED_BY: 10, POSSE: 11 };

// ---- quantisation of remote entities
export const qPos = v => Math.round(v * POS_Q);
export const qY = v => Math.round((v + Y_OFF) * Y_Q);
export const qYaw = a => Math.round((((a % TAU) + TAU) % TAU) / TAU * 256) & 255;
export const dPos = q => q / POS_Q;
export const dY = q => q / Y_Q - Y_OFF;
export const dYaw = b => b / 256 * TAU;

// ---- client -> server
export function encHello(w, name, token) {
  w.reset(); w.u8(MSG.HELLO); w.u16(PROTOCOL_VERSION); w.str(name); w.str(token || '');
  return w.bytes();
}
export function decHello(r) { return { proto: r.u16(), name: r.str(), token: r.str() }; }

// A packet of consecutive inputs. Each input is 8 bytes: strafe, forward (-127..127), view yaw (0..65535), view
// pitch (steps of a turn, + is up), buttons. viewMs is the server time (ms, low 16 bits) of the world the player was
// looking at when the newest of these inputs was made: the server rewinds everyone to that moment to judge a shot.
// After the inputs come hints, one for each shot in the packet that was aimed at someone: which input fired, who
// was under the sights, and when that person was where the shooter saw them (people further off are drawn further
// in the past). The server trusts a hint only so far back (REWIND_MAX).
export function encInputHead(w, firstSeq, count, viewMs) {
  w.reset(); w.u8(MSG.INPUT); w.u16(firstSeq); w.u16(viewMs & 65535); w.u8(count);
}
export function encCmd(w, mx, mz, yaw, pitch, buttons) { w.i8(mx); w.i8(mz); w.u16(yaw); w.i16(pitch); w.u16(buttons); }
export const CMD_SIZE = 8;
export function encHints(w, hints) { w.u8(hints.length); for (const h of hints) { w.u16(h.seq); w.u16(h.target); w.u16(h.ms & 65535); } }

export function encPing(w, clientTime) { w.reset(); w.u8(MSG.PING); w.f64(clientTime); return w.bytes(); }

// ---- a player's own state, at full precision: prediction replays from it. 26 bytes, 40 more when the horse is
// included and 24 more when the guns are. The server includes either whenever anything about it has changed since
// it last did.
export function writeSelf(w, a, withHorse, withGun = false) {
  const f = a.f;
  w.f32(f.x); w.f32(f.y); w.f32(f.z); w.f32(f.vx); w.f32(f.vy); w.f32(f.vz); w.u8(actorFlags(a) | (withHorse ? AF.HORSE_BLOCK : 0) | (withGun ? AF.GUN_BLOCK : 0)); w.u8(a.whT);
  if (withHorse) { const h = a.h; w.f32(h.x); w.f32(h.y); w.f32(h.z); w.f32(h.hx); w.f32(h.hz); w.f32(h.sp); w.f32(h.vy); w.f32(h.stam); w.f32(h.sd); w.u8(horseFlags(h)); w.u16(h.t); w.u8(h.st); }
  if (withGun) {
    w.u8(a.slot); w.u8(a.swap); w.u8(a.swapTo); w.u8(a.cool); w.u8(a.rel); w.u8(a.m1); w.u8(a.m2); w.u16(a.r1); w.u16(a.r2); w.u16(a.shots);
    w.u8(a.aimT); w.u8(a.gfl); w.u8(a.dead | (a.jail << 1)); w.f32(a.bloom); w.f32(a.focus);
  }
}
export const SELF_SIZE = 26, HORSE_SIZE = 40, GUN_SIZE = 24;
// read it into an actor; returns the flags byte. A horse the actor has, but which was not in the message, is left as it was.
export function readSelf(r, a) {
  const f = a.f;
  f.x = r.f32(); f.y = r.f32(); f.z = r.f32(); f.vx = r.f32(); f.vy = r.f32(); f.vz = r.f32();
  const fl = r.u8(); a.whT = r.u8();
  f.ground = fl & AF.GROUND ? 1 : 0; f.jumpHeld = fl & AF.JUMP_HELD ? 1 : 0; a.riding = fl & AF.RIDING ? 1 : 0; a.useHeld = fl & AF.USE_HELD ? 1 : 0; a.whHeld = fl & AF.WH_HELD ? 1 : 0;
  if (!(fl & AF.HAS_HORSE)) a.h = null;
  else if (!a.h) a.h = makeHorse(f.x, f.y, f.z);
  if (fl & AF.HORSE_BLOCK) {
    const h = a.h || (a.h = makeHorse());
    h.x = r.f32(); h.y = r.f32(); h.z = r.f32(); h.hx = r.f32(); h.hz = r.f32(); h.sp = r.f32(); h.vy = r.f32(); h.stam = r.f32(); h.sd = r.f32();
    const hf = r.u8(); h.ground = hf & 1; h.winded = (hf >> 1) & 1; h.mode = (hf >> 2) & 3; h.t = r.u16(); h.st = r.u8();
  }
  if (fl & AF.GUN_BLOCK) {
    a.slot = r.u8(); a.swap = r.u8(); a.swapTo = r.u8(); a.cool = r.u8(); a.rel = r.u8(); a.m1 = r.u8(); a.m2 = r.u8(); a.r1 = r.u16(); a.r2 = r.u16(); a.shots = r.u16();
    a.aimT = r.u8(); a.gfl = r.u8(); const d = r.u8(); a.dead = d & 1; a.jail = (d >> 1) & 1; a.bloom = r.f32(); a.focus = r.f32();
  }
  return fl;
}
// ---- what the server alone decides about a player, sent when it changes: health, whether the law wants them, how
// much the bounty is, where the law is looking for them, and a clock for whatever they are waiting on (getting up
// again after dying, or getting out of jail)
export const SS = { DEAD: 1, JAILED: 2, SEEN: 4, SURRENDER: 8 };
export function writeStatus(w, o) { w.u8(o.hp); w.u8(o.flags); w.u8(o.wanted); w.u16(o.bounty); w.u16(o.sx); w.u16(o.sz); w.u8(o.sr); w.u8(o.timer); w.u8(o.witnesses); }
export function readStatus(r, o) { o.hp = r.u8(); o.flags = r.u8(); o.wanted = r.u8(); o.bounty = r.u16(); o.sx = r.u16(); o.sz = r.u16(); o.sr = r.u8(); o.timer = r.u8(); o.witnesses = r.u8(); return o; }
export const STATUS_SIZE = 12;
export const sameStatus = (a, b) => a.hp === b.hp && a.flags === b.flags && a.wanted === b.wanted && a.bounty === b.bounty && a.sx === b.sx && a.sz === b.sz && a.sr === b.sr && a.timer === b.timer && a.witnesses === b.witnesses;
export const makeStatus = () => ({ hp: 100, flags: 0, wanted: 0, bounty: 0, sx: 0, sz: 0, sr: 0, timer: 0, witnesses: 0 });
const scratch = makeStatus();

// ---- events
export const EV_SIZE = [0, 11, 10, 6, 4];
export function writeEvent(w, ev) {
  w.u8(ev.type);
  if (ev.type === EV.SHOT) { w.u16(ev.id); w.u8(ev.gun); w.u16(ev.yaw); w.i16(ev.pitch); w.u16(Math.min(65535, Math.round(ev.dist * 10))); w.u8(ev.struck); }
  else if (ev.type === EV.HIT) { w.u16(ev.id); w.u16(ev.by); w.u8(ev.zone); w.u8(ev.dmg); w.u16(ev.yaw); w.u8(ev.hp); }
  else if (ev.type === EV.DIE) { w.u16(ev.id); w.u16(ev.by); w.u8(ev.zone); }
  else { w.u8(ev.code); w.u16(ev.value); }
}
function readEvent(r) {
  const type = r.u8(), ev = { type };
  if (type === EV.SHOT) { ev.id = r.u16(); ev.gun = r.u8(); ev.yaw = r.u16(); ev.pitch = r.i16(); ev.dist = r.u16() / 10; ev.struck = r.u8(); }
  else if (type === EV.HIT) { ev.id = r.u16(); ev.by = r.u16(); ev.zone = r.u8(); ev.dmg = r.u8(); ev.yaw = r.u16(); ev.hp = r.u8(); }
  else if (type === EV.DIE) { ev.id = r.u16(); ev.by = r.u16(); ev.zone = r.u8(); }
  else if (type === EV.NOTE) { ev.code = r.u8(); ev.value = r.u16(); }
  else throw new RangeError('unknown event');
  return ev;
}

// ---- server -> client
// welcome: who you are, what time it is (the tick, the clock, and the hour of the day), the world's seed, a token to
// come back with, and your whole state
export function encWelcome(w, o) {
  w.reset(); w.u8(MSG.WELCOME); w.u16(PROTOCOL_VERSION); w.u16(o.id); w.u8(o.tickRate); w.u32(o.tick);
  w.f64(o.serverNow); w.u32(o.dayMs); w.u32(o.seed); w.str(o.token); w.u16(o.horseId); writeSelf(w, o.actor, !!o.actor.h, true);
  return w.bytes();
}
export function decWelcome(r, actor) {
  const o = { proto: r.u16(), id: r.u16(), tickRate: r.u8(), tick: r.u32(), serverNow: r.f64(), dayMs: r.u32(), seed: r.u32(), token: r.str(), horseId: r.u16(), x: 0, y: 0, z: 0 };
  if (o.proto !== PROTOCOL_VERSION) return o;                    // another version's welcome may be laid out differently: read no further
  readSelf(r, actor); o.x = actor.f.x; o.y = actor.f.y; o.z = actor.f.z;
  return o;
}
export function encReject(w, code, text) { w.reset(); w.u8(MSG.REJECT); w.u8(code); w.str(text); return w.bytes(); }
// pong: the client's clock back, the server's clock, and how far into the day it is (ms)
export function encPong(w, clientTime, serverNow, dayMs) { w.reset(); w.u8(MSG.PONG); w.f64(clientTime); w.f64(serverNow); w.u32(dayMs); return w.bytes(); }

// ---- snapshot: the server's side writes with these, the client reads with readSnapshot
// header: tick, last input applied, then the receiving player's own state; then their status if it changed, then
// what happened that they could see
export function writeSnapshotHead(w, tick, ackSeq, a, withHorse, withGun = false) {
  w.reset(); w.u8(MSG.SNAPSHOT); w.u32(tick); w.u16(ackSeq); writeSelf(w, a, withHorse, withGun);
}
export const SNAPSHOT_HEAD = 7 + SELF_SIZE;
// a horse says whose it is
export function writeSpawn(w, e) {
  w.u16(e.id); w.u8(e.kind); w.u8(e.ef); w.str(e.name); w.u24(e.qx); w.u24(e.qz); w.u16(e.qy); w.u8(e.qyaw); w.u8(e.st); w.u8(e.gear);
  if (e.kind === KIND_HORSE) w.u16(e.owner.id);
}
export const spawnSize = e => 16 + Math.min(255, e.nameBytes) + (e.kind === KIND_HORSE ? 2 : 0);

// h.self(tick, ack, r) must read the player's own state from r (readSelf) before returning
export function readSnapshot(r, h) {
  const tick = r.u32(), ack = r.u16();
  h.self(tick, ack, r);
  if (r.u8() & 1) { if (h.status) h.status(r); else readStatus(r, scratch); }   // h.status(r) reads it with readStatus
  let n = r.u8();
  while (n--) { const ev = readEvent(r); if (h.event) h.event(tick, ev); }
  n = r.u8();
  while (n--) h.despawn(r.u16());
  n = r.u8();
  while (n--) {
    const id = r.u16(), kind = r.u8(), ef = r.u8(), name = r.str(), qx = r.u24(), qz = r.u24(), qy = r.u16(), yaw = r.u8(), st = r.u8(), gear = r.u8(), owner = kind === KIND_HORSE ? r.u16() : 0;
    h.spawn(tick, id, kind, ef, name, qx, qy, qz, yaw, st, owner, gear);
  }
  n = r.u8();
  while (n--) {
    const id = r.u16(), mask = r.u8(), hold = mask & UM.HOLD ? r.u8() : 0;
    let dx = 0, dy = 0, dz = 0, yaw = -1, st = -1, gear = -1;
    if (mask & UM.POS) { dx = r.vari(); dz = r.vari(); dy = r.vari(); }
    if (mask & UM.YAW) yaw = r.u8();
    if (mask & UM.STATE) st = r.u8();
    if (mask & UM.GEAR) gear = r.u8();
    h.update(tick, id, mask, hold, dx, dy, dz, yaw, st, gear);
  }
}
