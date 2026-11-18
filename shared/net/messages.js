// Every message on the wire, both directions. The first byte is the message type.
// docs/PROTOCOL.md describes the same layouts in words; change both together and bump PROTOCOL_VERSION.
import { PROTOCOL_VERSION, POS_Q, Y_Q, Y_OFF, KIND_HORSE } from '../constants.js';
import { AF, actorFlags } from '../sim/actor.js';
import { horseFlags, makeHorse } from '../sim/moveHorse.js';
import { TAU } from '../math.js';

export const MSG = { HELLO: 1, WELCOME: 2, INPUT: 3, SNAPSHOT: 4, PING: 5, PONG: 6, REJECT: 7 };
export const REJECT = { VERSION: 1, FULL: 2, BAD: 3 };
// update mask bits in a snapshot
export const UM = { POS: 1, YAW: 2, STATE: 4, HOLD: 0x80 };

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

// A packet of consecutive inputs. Each input is 5 bytes: strafe, forward (-127..127), view yaw (0..65535), buttons.
// viewMs is the server time (ms, low 16 bits) of the world the player was looking at when the newest of these
// inputs was made. From Phase 4 the server rewinds targets to that moment to judge a shot.
export function encInputHead(w, firstSeq, count, viewMs) {
  w.reset(); w.u8(MSG.INPUT); w.u16(firstSeq); w.u16(viewMs & 65535); w.u8(count);
}
export function encCmd(w, mx, mz, yaw, buttons) { w.i8(mx); w.i8(mz); w.u16(yaw); w.u8(buttons); }

export function encPing(w, clientTime) { w.reset(); w.u8(MSG.PING); w.f64(clientTime); return w.bytes(); }

// ---- a player's own state, at full precision: prediction replays from it. 26 bytes, and 40 more when the horse is
// included. The server includes the horse whenever anything about it has changed since it last did.
export function writeSelf(w, a, withHorse) {
  const f = a.f;
  w.f32(f.x); w.f32(f.y); w.f32(f.z); w.f32(f.vx); w.f32(f.vy); w.f32(f.vz); w.u8(actorFlags(a) | (withHorse ? AF.HORSE_BLOCK : 0)); w.u8(a.whT);
  if (withHorse) { const h = a.h; w.f32(h.x); w.f32(h.y); w.f32(h.z); w.f32(h.hx); w.f32(h.hz); w.f32(h.sp); w.f32(h.vy); w.f32(h.stam); w.f32(h.sd); w.u8(horseFlags(h)); w.u16(h.t); w.u8(h.st); }
}
export const SELF_SIZE = 26, HORSE_SIZE = 40;
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
  return fl;
}

// ---- server -> client
// welcome: who you are, what time it is (the tick, the clock, and the hour of the day), the world's seed, a token to
// come back with, and your whole state
export function encWelcome(w, o) {
  w.reset(); w.u8(MSG.WELCOME); w.u16(PROTOCOL_VERSION); w.u16(o.id); w.u8(o.tickRate); w.u32(o.tick);
  w.f64(o.serverNow); w.u32(o.dayMs); w.u32(o.seed); w.str(o.token); w.u16(o.horseId); writeSelf(w, o.actor, !!o.actor.h);
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
// header: tick, last input applied, then the receiving player's own state
export function writeSnapshotHead(w, tick, ackSeq, a, withHorse) {
  w.reset(); w.u8(MSG.SNAPSHOT); w.u32(tick); w.u16(ackSeq); writeSelf(w, a, withHorse);
}
export const SNAPSHOT_HEAD = 7 + SELF_SIZE;
// a horse says whose it is
export function writeSpawn(w, e) {
  w.u16(e.id); w.u8(e.kind); w.u8(e.ef); w.str(e.name); w.u24(e.qx); w.u24(e.qz); w.u16(e.qy); w.u8(e.qyaw); w.u8(e.st);
  if (e.kind === KIND_HORSE) w.u16(e.owner.id);
}
export const spawnSize = e => 15 + Math.min(255, e.nameBytes) + (e.kind === KIND_HORSE ? 2 : 0);

// h.self(tick, ack, r) must read the player's own state from r (readSelf) before returning
export function readSnapshot(r, h) {
  const tick = r.u32(), ack = r.u16();
  h.self(tick, ack, r);
  let n = r.u8();
  while (n--) h.despawn(r.u16());
  n = r.u8();
  while (n--) {
    const id = r.u16(), kind = r.u8(), ef = r.u8(), name = r.str(), qx = r.u24(), qz = r.u24(), qy = r.u16(), yaw = r.u8(), st = r.u8(), owner = kind === KIND_HORSE ? r.u16() : 0;
    h.spawn(tick, id, kind, ef, name, qx, qy, qz, yaw, st, owner);
  }
  n = r.u8();
  while (n--) {
    const id = r.u16(), mask = r.u8(), hold = mask & UM.HOLD ? r.u8() : 0;
    let dx = 0, dy = 0, dz = 0, yaw = -1, st = -1;
    if (mask & UM.POS) { dx = r.vari(); dz = r.vari(); dy = r.vari(); }
    if (mask & UM.YAW) yaw = r.u8();
    if (mask & UM.STATE) st = r.u8();
    h.update(tick, id, mask, hold, dx, dy, dz, yaw, st);
  }
}
