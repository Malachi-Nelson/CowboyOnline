// A world, a clock and any number of sessions in one process, with no sockets and no real time. Tests move the
// clock themselves, so every run is the same.
import { World } from '../server/src/core/world.js';
import { Session } from '../client/src/net/session.js';
import { TICK_MS } from '../shared/constants.js';
import { Reader } from '../shared/net/codec.js';

export function rig(worldOpts = {}) {
  const clock = { t: 0 };
  const world = new World({ bots: 0, ...worldOpts, now: () => clock.t });
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
