// Every message on the wire, both directions. The first byte is the message type.
// docs/PROTOCOL.md describes the same layouts in words; change both together and bump PROTOCOL_VERSION.
import { PROTOCOL_VERSION, POS_Q, Y_Q, Y_OFF } from '../constants.js';
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

// ---- server -> client
export function encWelcome(w, o) {
  w.reset(); w.u8(MSG.WELCOME); w.u16(PROTOCOL_VERSION); w.u16(o.id); w.u8(o.tickRate); w.u32(o.tick);
  w.f64(o.serverNow); w.u32(o.seed); w.str(o.token); w.f32(o.x); w.f32(o.y); w.f32(o.z);
  return w.bytes();
}
export function decWelcome(r) {
  return { proto: r.u16(), id: r.u16(), tickRate: r.u8(), tick: r.u32(), serverNow: r.f64(), seed: r.u32(), token: r.str(), x: r.f32(), y: r.f32(), z: r.f32() };
}
export function encReject(w, code, text) { w.reset(); w.u8(MSG.REJECT); w.u8(code); w.str(text); return w.bytes(); }
export function encPong(w, clientTime, serverNow) { w.reset(); w.u8(MSG.PONG); w.f64(clientTime); w.f64(serverNow); return w.bytes(); }

// ---- snapshot: the server's side writes with these, the client reads with readSnapshot
// header: tick, last input applied, then the receiving player's own state at full precision (prediction replays from it)
export function writeSnapshotHead(w, tick, ackSeq, s, flags) {
  w.reset(); w.u8(MSG.SNAPSHOT); w.u32(tick); w.u16(ackSeq);
  w.f32(s.x); w.f32(s.y); w.f32(s.z); w.f32(s.vx); w.f32(s.vy); w.f32(s.vz); w.u8(flags);
}
export const SNAPSHOT_HEAD = 32;
export function writeSpawn(w, e) {
  w.u16(e.id); w.u8(e.kind); w.u8(e.ef); w.str(e.name); w.u24(e.qx); w.u24(e.qz); w.u16(e.qy); w.u8(e.qyaw); w.u8(e.st);
}
export const spawnSize = e => 15 + Math.min(255, e.nameBytes);

export function readSnapshot(r, h) {
  const tick = r.u32(), ack = r.u16();
  const x = r.f32(), y = r.f32(), z = r.f32(), vx = r.f32(), vy = r.f32(), vz = r.f32(), fl = r.u8();
  h.self(tick, ack, x, y, z, vx, vy, vz, fl);
  let n = r.u8();
  while (n--) h.despawn(r.u16());
  n = r.u8();
  while (n--) {
    const id = r.u16(), kind = r.u8(), ef = r.u8(), name = r.str(), qx = r.u24(), qz = r.u24(), qy = r.u16(), yaw = r.u8(), st = r.u8();
    h.spawn(tick, id, kind, ef, name, qx, qy, qz, yaw, st);
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
