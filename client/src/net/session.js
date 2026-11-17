// One player's connection to a world. This is the client half of the netcode and it has no browser in it: the game
// page drives it from its frame loop, and the load test drives 64 of them from Node.
//
// It does three jobs.
//   Prediction. Each 1/60 s it samples the controls, steps the player's own body at once with the shared movement
//   code, and sends the input. The server runs the same step on the same numbers, so its answer normally matches.
//   Reconciliation. Every snapshot says "after your input number N you were here". If that disagrees with what was
//   predicted for N, the body is put where the server says and the inputs after N are run again.
//   Interpolation. Everyone else is drawn a little in the past, sliding between the positions the server sent.
import { SIM_DT, TICK_MS, PROTOCOL_VERSION } from '../../../shared/constants.js';
import { Writer, Reader } from '../../../shared/net/codec.js';
import { MSG, encHello, encInputHead, encCmd, encPing, decWelcome, readSnapshot, dPos, dY, dYaw } from '../../../shared/net/messages.js';
import { makeField } from '../../../shared/world/field.js';
import { makeFoot, stepFoot, FLAG } from '../../../shared/sim/moveFoot.js';
import { seqDiff } from '../../../shared/math.js';
import { Remote, intervalFor, isMoving } from './interp.js';

const RING = 256;                // inputs remembered for replay (4.2 s)
const EPS_POS = 0.01;            // metres of disagreement that count as a misprediction
const EPS_VEL = 0.05;            // m/s
const MAX_FRAME = 0.25;          // a frame longer than this is treated as a pause, not as time to catch up on
const SMOOTH_TAU = 0.1;          // s; how quickly the view glides onto a corrected position
const SNAP = 3;                  // metres; a correction bigger than this is shown at once
const MIN_DELAY = 2 * TICK_MS;   // others are never drawn less than this far in the past
const PER_PACKET = 3;            // inputs per packet: 20 packets a second
const frameIn = n => n + (n < 126 ? 2 : 4), frameOut = n => n + (n < 126 ? 6 : 8);

const fields = new Map();
export function fieldFor(seed) { let f = fields.get(seed); if (!f) fields.set(seed, f = makeField(seed)); return f; }

export class Session {
  // transport: { open(), send(bytes), close(), onopen, onmessage(bytes), onclose(reason) }
  // opts: { name, token, now(), sample(cmd, session) }
  constructor(transport, opts = {}) {
    this.t = transport; this.name = opts.name || 'Rider'; this.token = opts.token || '';
    this.now = opts.now || (() => performance.now());
    this.sample = opts.sample || null;
    this.state = 'connecting'; this.reason = '';
    this.id = 0; this.seed = 0; this.field = null;
    this.w = new Writer(256); this.r = new Reader(new Uint8Array(0));

    // own body: predicted now, the step before (for drawing between steps), and the glide after a correction
    this.me = makeFoot(); this.prevX = 0; this.prevY = 0; this.prevZ = 0;
    this.ox = 0; this.oy = 0; this.oz = 0;
    this.x = 0; this.y = 0; this.z = 0;                       // where to draw the player this frame
    this.cmd = { mx: 0, mz: 0, yaw: 0, buttons: 0 };
    this.seq = 1; this.ack = 0; this.batch = 0; this.acc = 0; this.last = 0;
    this.cMx = new Int8Array(RING); this.cMz = new Int8Array(RING); this.cYaw = new Uint16Array(RING); this.cBtn = new Uint8Array(RING);
    this.pX = new Float64Array(RING); this.pY = new Float64Array(RING); this.pZ = new Float64Array(RING);
    this.pVx = new Float64Array(RING); this.pVy = new Float64Array(RING); this.pVz = new Float64Array(RING); this.pFl = new Uint8Array(RING);

    // everyone else
    this.ents = new Map(); this.tick = 0;
    this.tOff = 0; this.jit = 0; this.synced = false;        // server tick time = local time + tOff, as snapshots arrive
    this.nearDelay = MIN_DELAY;
    this.rtt = 0; this.rttMin = Infinity; this.nextPing = 0; this.pings = 0;

    this.stats = { bytesIn: 0, bytesOut: 0, snapshots: 0, inputs: 0, corrections: 0, errLast: 0, errMax: 0, errN: 0, errs: new Float32Array(8192), errHist: new Uint32Array(6), unknown: 0, lateFrames: 0, entFrames: 0, snapMax: 0 };
    this.onwelcome = null; this.onclose = null; this.onspawn = null; this.ondespawn = null; this.onself = null;

    this.snap = {
      self: (tick, ack, x, y, z, vx, vy, vz, fl) => this.reconcile(tick, ack, x, y, z, vx, vy, vz, fl),
      despawn: id => { const e = this.ents.get(id); if (e) { this.ents.delete(id); if (this.ondespawn) this.ondespawn(e); } },
      spawn: (tick, id, kind, ef, name, qx, qy, qz, yaw, st) => {
        let e = this.ents.get(id);
        if (e && this.ondespawn) this.ondespawn(e);
        e = new Remote(id, kind, ef, name);
        e.qx = qx; e.qy = qy; e.qz = qz; e.qyaw = yaw; e.st = st;
        e.push(tick * TICK_MS, dPos(qx), dY(qy), dPos(qz), dYaw(yaw), isMoving(st));
        e.sample(tick * TICK_MS);
        this.ents.set(id, e);
        if (this.onspawn) this.onspawn(e);
      },
      update: (tick, id, mask, hold, dx, dy, dz, yaw, st) => {
        const e = this.ents.get(id);
        if (!e) { this.stats.unknown++; return; }
        const t = tick * TICK_MS, before = e.newest;
        // it stood where it was until `hold` ticks ago: say so, or it would be drawn drifting through its rest
        if (hold) e.push(t - hold * TICK_MS, dPos(e.qx), dY(e.qy), dPos(e.qz), dYaw(e.qyaw), false);
        e.qx += dx; e.qy += dy; e.qz += dz; if (yaw >= 0) e.qyaw = yaw; if (st >= 0) e.st = st;
        const gap = t - (hold ? t - hold * TICK_MS : before);
        e.ival += ((gap > 600 ? 600 : gap) - e.ival) * 0.25;
        e.push(t, dPos(e.qx), dY(e.qy), dPos(e.qz), dYaw(e.qyaw), isMoving(e.st));
      },
    };

    transport.onopen = () => this.send(encHello(this.w, this.name, this.token));
    transport.onmessage = u8 => this.receive(u8);
    transport.onclose = reason => { if (this.state !== 'rejected') { this.state = 'closed'; this.reason = reason || this.reason; } if (this.onclose) this.onclose(this.reason); };
  }
  open() { this.t.open(); return this; }
  close() { this.t.close(); }
  send(bytes) { this.stats.bytesOut += frameOut(bytes.length); this.t.send(bytes); }

  receive(u8) {
    const st = this.stats; st.bytesIn += frameIn(u8.length);
    const r = this.r.set(u8), type = r.u8();
    if (type === MSG.SNAPSHOT) {
      if (this.state !== 'playing') return;
      if (u8.length > st.snapMax) st.snapMax = u8.length;
      st.snapshots++;
      readSnapshot(r, this.snap);
    } else if (type === MSG.PONG) {
      const sent = r.f64(), rtt = this.now() - sent;
      this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.2 : rtt;
      if (rtt < this.rttMin) this.rttMin = rtt;
    } else if (type === MSG.WELCOME) {
      const o = decWelcome(r);
      if (o.proto !== PROTOCOL_VERSION) { this.state = 'rejected'; this.reason = 'This page and the server are different versions.'; this.t.close(); return; }
      this.id = o.id; this.seed = o.seed; this.token = o.token; this.field = fieldFor(o.seed); this.tick = o.tick;
      const m = this.me; m.x = o.x; m.y = o.y; m.z = o.z; m.vx = m.vy = m.vz = 0; m.ground = 1; m.jumpHeld = 0;
      this.prevX = this.x = o.x; this.prevY = this.y = o.y; this.prevZ = this.z = o.z;
      this.seq = 1; this.ack = 0; this.batch = 0; this.acc = 0; this.last = this.now(); this.synced = false;
      this.remember(0);                                          // "after input 0": where the server put us
      this.ents.clear();
      this.state = 'playing';
      if (this.onwelcome) this.onwelcome(o);
    } else if (type === MSG.REJECT) {
      r.u8(); this.state = 'rejected'; this.reason = r.str();
    }
  }

  // ---- reconciliation
  reconcile(tick, ack, x, y, z, vx, vy, vz, fl) {
    const now = this.now(), st = this.stats, m = this.me;
    this.tick = tick;
    // the clock others are drawn against: follow the average arrival, and remember how late the latest ones run
    const s = tick * TICK_MS - now;
    if (!this.synced || Math.abs(s - this.tOff) > 400) { this.tOff = s; this.jit = 0; this.synced = true; }
    else { const dev = s - this.tOff; this.tOff += dev * 0.02; const a = dev < 0 ? -dev : dev; this.jit = a > this.jit ? a : this.jit * 0.995; }
    if (this.onself) this.onself(tick, ack, x, y, z);

    if (seqDiff(ack, this.ack) < 0) return;
    this.ack = ack;
    const pending = seqDiff(this.seq, ack) - 1;                  // inputs made that the server has not applied yet
    if (pending < 0 || pending >= RING) return;                  // nothing of ours to compare against
    const i0 = ack & (RING - 1), ex = this.pX[i0] - x, ey = this.pY[i0] - y, ez = this.pZ[i0] - z, err = Math.sqrt(ex * ex + ey * ey + ez * ez);
    st.errLast = err; if (err > st.errMax) st.errMax = err;
    st.errs[st.errN++ & 8191] = err;
    st.errHist[err < 1e-3 ? 0 : err < 0.01 ? 1 : err < 0.05 ? 2 : err < 0.1 ? 3 : err < 0.5 ? 4 : 5]++;
    if (!(err > EPS_POS || Math.abs(this.pVx[i0] - vx) > EPS_VEL || Math.abs(this.pVy[i0] - vy) > EPS_VEL || Math.abs(this.pVz[i0] - vz) > EPS_VEL || this.pFl[i0] !== fl)) return;
    // The server disagrees. Take its word, then run again every input it has not seen yet.
    const bx = m.x, by = m.y, bz = m.z, c = this.cmd, keep = { mx: c.mx, mz: c.mz, yaw: c.yaw, buttons: c.buttons };
    m.x = x; m.y = y; m.z = z; m.vx = vx; m.vy = vy; m.vz = vz; m.ground = fl & FLAG.GROUND ? 1 : 0; m.jumpHeld = fl & FLAG.JUMP_HELD ? 1 : 0;
    for (let q = (ack + 1) & 65535, n = pending; n > 0; n--, q = (q + 1) & 65535) {
      const i = q & (RING - 1);
      if (n === 1) { this.prevX = m.x; this.prevY = m.y; this.prevZ = m.z; }
      c.mx = this.cMx[i]; c.mz = this.cMz[i]; c.yaw = this.cYaw[i]; c.buttons = this.cBtn[i];
      stepFoot(m, c, this.field); this.remember(i);
    }
    if (pending === 0) { this.prevX = m.x; this.prevY = m.y; this.prevZ = m.z; }
    c.mx = keep.mx; c.mz = keep.mz; c.yaw = keep.yaw; c.buttons = keep.buttons;
    this.ox += bx - m.x; this.oy += by - m.y; this.oz += bz - m.z;
    if (this.ox * this.ox + this.oy * this.oy + this.oz * this.oz > SNAP * SNAP) this.ox = this.oy = this.oz = 0;
    st.corrections++;
  }
  remember(i) {
    const m = this.me;
    this.pX[i] = m.x; this.pY[i] = m.y; this.pZ[i] = m.z; this.pVx[i] = m.vx; this.pVy[i] = m.vy; this.pVz[i] = m.vz;
    this.pFl[i] = (m.ground ? FLAG.GROUND : 0) | (m.jumpHeld ? FLAG.JUMP_HELD : 0);
  }

  // ---- one input: sample, predict, remember, and send every third
  input() {
    if (seqDiff(this.seq, this.ack) > RING - 16) return;         // the server has gone quiet: stop running ahead of it
    const c = this.cmd, m = this.me, seq = this.seq, i = seq & (RING - 1);
    if (this.sample) this.sample(c, this);
    // exactly the numbers the wire carries, so both sides step with the same input
    c.mx = Math.max(-127, Math.min(127, Math.round(c.mx))) | 0; c.mz = Math.max(-127, Math.min(127, Math.round(c.mz))) | 0;
    c.yaw = Math.round(c.yaw) & 65535; c.buttons &= 7;
    this.cMx[i] = c.mx; this.cMz[i] = c.mz; this.cYaw[i] = c.yaw; this.cBtn[i] = c.buttons;
    this.prevX = m.x; this.prevY = m.y; this.prevZ = m.z;
    stepFoot(m, c, this.field); this.remember(i);
    this.seq = (seq + 1) & 65535; this.stats.inputs++;
    if (++this.batch === PER_PACKET) {
      const w = this.w, first = (seq - (PER_PACKET - 1)) & 65535;
      encInputHead(w, first, PER_PACKET, Math.floor(this.now() + this.tOff - this.nearDelay));
      for (let k = 0; k < PER_PACKET; k++) { const j = (first + k) & (RING - 1); encCmd(w, this.cMx[j], this.cMz[j], this.cYaw[j], this.cBtn[j]); }
      this.send(w.bytes()); this.batch = 0;
    }
  }

  // ---- once per drawn frame (or per timer tick in the load test)
  frame(now = this.now()) {
    if (this.state !== 'playing') return;
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt < 0) dt = 0; else if (dt > MAX_FRAME) dt = MAX_FRAME;
    this.acc += dt;
    while (this.acc >= SIM_DT) { this.acc -= SIM_DT; this.input(); }
    const k = Math.exp(-dt / SMOOTH_TAU), a = this.acc / SIM_DT, m = this.me;
    this.ox *= k; this.oy *= k; this.oz *= k;
    this.x = this.prevX + (m.x - this.prevX) * a + this.ox;
    this.y = this.prevY + (m.y - this.prevY) * a + this.oy;
    this.z = this.prevZ + (m.z - this.prevZ) * a + this.oz;

    // everyone else, each at its own distance into the past
    const est = now + this.tOff, slack = this.jit + 10, ease = 1 - Math.exp(-dt / 0.25), st = this.stats;
    this.nearDelay = Math.max(MIN_DELAY, TICK_MS + slack);
    for (const e of this.ents.values()) {
      const dx = e.x - this.x, dz = e.z - this.z, want = Math.max(MIN_DELAY, Math.max(intervalFor(Math.sqrt(dx * dx + dz * dz)), e.ival) + slack);
      e.delay = e.delay ? e.delay + (want - e.delay) * ease : want;
      e.sample(est - e.delay);
      st.entFrames++; if (e.late > 0 && isMoving(e.st)) st.lateFrames++;
    }
    if (now >= this.nextPing) { this.send(encPing(this.w, now)); this.nextPing = now + (this.pings++ < 8 ? 250 : 1000); }
  }

  // error percentiles over the last 8,192 snapshots
  errors() {
    const n = Math.min(this.stats.errN, 8192), a = Array.from(this.stats.errs.subarray(0, n)).sort((p, q) => p - q);
    const at = p => (n ? a[Math.min(n - 1, Math.floor(p * n))] : 0);
    return { n, p50: at(0.5), p99: at(0.99), max: n ? a[n - 1] : 0 };
  }
}
