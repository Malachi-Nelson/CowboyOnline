// A world, a clock and any number of sessions in one process, with no sockets and no real time. Tests move the
// clock themselves, so every run is the same.
import { World } from '../server/src/core/world.js';
import { Session } from '../client/src/net/session.js';
import { TICK_MS } from '../shared/constants.js';
import { Reader } from '../shared/net/codec.js';

export function rig(worldOpts = {}) {
  const clock = { t: 0 };
  const world = new World({ bots: 0, lawmen: 0, ...worldOpts, now: () => clock.t });
  const queue = [];                                              // [at, order, fn], delivered in time order
  let order = 0, nextTick = TICK_MS;
  const later = (ms, fn) => { queue.push([clock.t + ms, order++, fn]); };

  // a session joined to the world through a pipe with `lag` ms each way (a function may vary it per message)
  function join(name, lag = 0, opts = {}) {
    const lagOf = typeof lag === 'function' ? lag : () => lag;
    const t = { onopen: null, onmessage: null, onclose: null, closed: false, upLast: 0, downLast: 0, sent: [] };
    let c = null;
    t.open = () => {
      c = t.client = world.connect({
        send: b => { const at = Math.max(t.downLast, clock.t + lagOf('down')); t.downLast = at; later(at - clock.t, () => { if (!t.closed && t.onmessage) t.onmessage(b); }); },
        close: () => { t.closed = true; if (t.onclose) t.onclose('closed by the world'); },
        buffered: 0,
      });
      later(0, () => t.onopen && t.onopen());
    };
    t.send = b => { t.sent.push(b); const at = Math.max(t.upLast, clock.t + lagOf('up')); t.upLast = at; later(at - clock.t, () => { if (!t.closed) world.receive(c, b); }); };
    t.close = () => { t.closed = true; world.disconnect(c); };
    const s = new Session(t, { name, now: () => clock.t, ...opts });
    s.pipe = t; s.open();
    return s;
  }

  const sessions = [];
  // advance the clock by `ms`, one millisecond at a time: deliver what is due, tick the world, run the frames
  function run(ms, frameEvery = 16) {
    for (let i = 0; i < ms; i++) {
      clock.t += 1;
      queue.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      while (queue.length && queue[0][0] <= clock.t) queue.shift()[2]();
      if (clock.t >= nextTick) { world.step(); nextTick += TICK_MS; }
      if (clock.t % frameEvery === 0) for (const s of sessions) s.frame(clock.t);
    }
  }
  const flush = () => { while (queue.length) { queue.sort((a, b) => a[0] - b[0] || a[1] - b[1]); queue.shift()[2](); } };
  return { clock, world, run, later, flush, join: (...a) => { const s = join(...a); sessions.push(s); return s; }, raw: () => rawClient(world) };
}

// a bare connection, for sending things a real client never would
export function rawClient(world) {
  const got = []; let closed = false;
  const c = world.connect({ send: b => got.push(b), close: () => { closed = true; }, buffered: 0 });
  return { c, got, get closed() { return closed; }, send: b => world.receive(c, b), types: () => got.map(b => b[0]), reader: i => { const r = new Reader(got[i]); r.u8(); return r; } };
}

// ---- for gunfights: aiming, raw players who send exactly what a test says, and putting people places
import { Writer as W2 } from '../shared/net/codec.js';
import { encHello, encInputHead, encCmd, encHints } from '../shared/net/messages.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { AIM, WEAPON_SHIFT } from '../shared/sim/guns.js';
import { SIN16, COS16 } from '../shared/sim/trig.js';
import { TAU } from '../shared/math.js';
const wr = new W2(512), WPN = n => n << WEAPON_SHIFT;
// the yaw and pitch (steps of a turn) that put a shot from actor a's gun line through (tx, ty, tz)
export function aim(a, tx, ty, tz) {
  let yaw = 0, pitch = 0;
  for (let k = 0; k < 4; k++) {
    const yi = Math.round(yaw / TAU * 65536) & 65535, sh = a.riding ? AIM.rideShoulder : AIM.shoulder, hd = (a.riding ? AIM.rideHead : AIM.head) + AIM.up;
    const ox = a.f.x + COS16[yi] * sh, oy = a.f.y + hd, oz = a.f.z - SIN16[yi] * sh, dx = tx - ox, dy = ty - oy, dz = tz - oz;
    yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  return { yaw: Math.round(yaw / TAU * 65536) & 65535, pitch: Math.round(pitch / TAU * 65536) };
}
// a raw player: sends a packet of three inputs every tick; `buttons` is what is held, fire() presses the trigger once
export function shooter(r, name) {
  const raw = r.raw(); wr.reset(); raw.send(encHello(wr, name, ''));
  const p = raw.c.player; let seq = 1;
  const o = {
    raw, p, buttons: WPN(1) | BTN.AIM, yaw: 0, pitch: 0, mx: 0, mz: 0, viewAge: 100, hints: [],
    send(fireAt = -1) {
      encInputHead(wr, seq, 3, Math.floor(r.world.serverNow()) - o.viewAge);
      for (let i = 0; i < 3; i++) encCmd(wr, o.mx, o.mz, o.yaw, o.pitch, o.buttons | (i === fireAt ? BTN.FIRE : 0));
      encHints(wr, fireAt >= 0 ? o.hints.map(x => ({ ...x, seq: seq + fireAt })) : []);
      raw.send(wr.bytes()); seq = (seq + 3) & 65535;
    },
    hold(n, others = []) { for (let i = 0; i < n; i++) { o.send(); for (const q of others) q.send(); r.run(TICK_MS); } },
    fire(others = []) { o.send(2); for (const q of others) q.send(); r.run(TICK_MS); },
    at(x, y, z) { const t = aim(p.a, x, y, z); o.yaw = t.yaw; o.pitch = t.pitch; },
  };
  return o;
}
// put a player at (x, z) on the ground, their horse well out of the way
export const place = (p, x, z, field) => { const T = field.terrain; p.s.x = Math.fround(x); p.s.z = Math.fround(z); p.s.y = Math.fround(field.groundAt(x, z, T.heightAt(x, z) + 1)); p.s.vx = p.s.vz = 0; if (p.a.h) { p.a.h.x = Math.fround(x + 30); p.a.h.z = Math.fround(z + 40); p.a.h.y = T.heightAt(p.a.h.x, p.a.h.z); } };
