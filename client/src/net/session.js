// One player's connection to a world. This is the client half of the netcode and it has no browser in it: the game
// page drives it from its frame loop, and the load test drives 64 of them from Node.
//
// It does three jobs.
//   Prediction. Each 1/60 s it samples the controls, steps the player at once with the shared movement code (their
//   body, and their horse whether they are on it or have just whistled for it), and sends the input. The server
//   runs the same step on the same numbers, so its answer normally matches.
//   Reconciliation. Every snapshot says "after your input number N this was your state". If that disagrees with
//   what was predicted for N, the player is put where the server says and the inputs after N are run again.
//   Interpolation. Everyone else is drawn a little in the past, sliding between the positions the server sent.
import { SIM_DT, TICK_MS, PROTOCOL_VERSION, DAY_MS, KIND_HORSE, ST_RIDING, ST_WHISTLE, GR_DEAD } from '../../../shared/constants.js';
import { Writer, Reader } from '../../../shared/net/codec.js';
import { MSG, UM, encHello, encInputHead, encCmd, encHints, encPing, decWelcome, readSnapshot, readSelf, readStatus, makeStatus, dPos, dY, dYaw } from '../../../shared/net/messages.js';
import { rayPerson, rayHorse } from '../../../shared/world/raycast.js';
import { PITCH_MAX } from '../../../shared/sim/guns.js';
import { makeField } from '../../../shared/world/field.js';
import { BTN_MASK } from '../../../shared/sim/moveFoot.js';
import { makeActor, copyActor, stepActor, packActor, sameActor, ROW_F, ROW_B, ROW_T } from '../../../shared/sim/actor.js';
import { seqDiff, yawOf } from '../../../shared/math.js';
import { Remote, intervalFor, isMoving } from './interp.js';

const RING = 256;                // inputs remembered for replay (4.2 s)
const EPS = 0.001;               // disagreement that counts as a misprediction. Both sides run the same arithmetic,
                                 // so the honest answer is normally zero; this only forgives dust.
const MAX_FRAME = 0.25;          // a frame longer than this is treated as a pause, not as time to catch up on
const SMOOTH_TAU = 0.1;          // s; how quickly the view glides onto a corrected position
const SNAP = 3;                  // metres; a correction bigger than this is shown at once
const MIN_DELAY = 2 * TICK_MS;   // others are never drawn less than this far in the past
const PER_PACKET = 3;            // inputs per packet: 20 packets a second
const JUMP2 = (20 * 32) * (20 * 32);   // an entity that moves 20 m between two updates was put there, not carried
const frameIn = n => n + (n < 126 ? 2 : 4), frameOut = n => n + (n < 126 ? 6 : 8);

export const fieldFor = makeField;

export class Session {
  // transport: { open(), send(bytes), close(), onopen, onmessage(bytes), onclose(reason) }
  // opts: { name, token, now(), sample(cmd, session) }
  constructor(transport, opts = {}) {
    this.t = transport; this.name = opts.name || 'Rider'; this.token = opts.token || '';
    this.now = opts.now || (() => performance.now());
    this.sample = opts.sample || null;
    this.state = 'connecting'; this.reason = '';
    this.id = 0; this.horseId = 0; this.seed = 0; this.field = null;
    this.w = new Writer(256); this.r = new Reader(new Uint8Array(0));

    // The player: predicted now (a), as the server last described it (srv), and where to draw body and horse this
    // frame. Drawing runs between steps and glides after a correction, so it has positions of its own.
    this.a = makeActor(0, 0, 0, true); this.srv = makeActor(0, 0, 0, true); this.me = this.a.f;
    this.prevX = 0; this.prevY = 0; this.prevZ = 0; this.ox = 0; this.oy = 0; this.oz = 0;
    this.x = 0; this.y = 0; this.z = 0;
    this.pH = { x: 0, y: 0, z: 0, hx: 0, hz: -1 }; this.oH = { x: 0, y: 0, z: 0 };
    this.horse = { x: 0, y: 0, z: 0, yaw: 0, sp: 0 };          // the player's own horse as drawn; valid while a.h exists
    this.cmd = { mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };
    this.seq = 1; this.ack = 0; this.batch = 0; this.acc = 0; this.last = 0;
    this.cMx = new Int8Array(RING); this.cMz = new Int8Array(RING); this.cYaw = new Uint16Array(RING); this.cPitch = new Int16Array(RING); this.cBtn = new Uint16Array(RING);
    this.pF = new Float32Array(RING * ROW_F); this.pB = new Uint8Array(RING * ROW_B); this.pT = new Uint16Array(RING * ROW_T);
    this.hints = []; this.pz = { zone: 0 };
    this.status = makeStatus();                                // what the server alone decides: health, the law

    // everyone else
    this.ents = new Map(); this.horseOf = new Map(); this.tick = 0;
    this.tOff = 0; this.jit = 0; this.synced = false;        // server tick time = local time + tOff, as snapshots arrive
    this.dayOff = 0;                                           // the time of day is server time + this, wrapped
    this.nearDelay = MIN_DELAY;
    this.rtt = 0; this.rttMin = Infinity; this.nextPing = 0; this.pings = 0;

    this.stats = { bytesIn: 0, bytesOut: 0, snapshots: 0, inputs: 0, corrections: 0, errLast: 0, errMax: 0, errN: 0, errs: new Float32Array(8192), errHist: new Uint32Array(6), unknown: 0, lateFrames: 0, entFrames: 0, snapMax: 0 };
    this.onwelcome = null; this.onclose = null; this.onspawn = null; this.ondespawn = null; this.onself = null; this.onwhistle = null;
    this.onshot = null; this.onevent = null; this.onstatus = null;

    this.snap = {
      self: (tick, ack, r) => this.reconcile(tick, ack, r),
      status: r => { readStatus(r, this.status); if (this.onstatus) this.onstatus(this.status); },
      event: (tick, ev) => { if (this.onevent) this.onevent(ev, tick); },
      despawn: id => {
        const e = this.ents.get(id); if (!e) return;
        this.ents.delete(id); if (e.kind === KIND_HORSE && this.horseOf.get(e.owner) === e) this.horseOf.delete(e.owner);
        if (this.ondespawn) this.ondespawn(e);
      },
      spawn: (tick, id, kind, ef, name, qx, qy, qz, yaw, st, owner, gear) => {
        let e = this.ents.get(id);
        if (e && this.ondespawn) this.ondespawn(e);
        e = new Remote(id, kind, ef, name); e.owner = owner;
        e.qx = qx; e.qy = qy; e.qz = qz; e.qyaw = yaw; e.st = st; e.gear = gear;
        e.push(tick * TICK_MS, dPos(qx), dY(qy), dPos(qz), dYaw(yaw), isMoving(st));
        e.sample(tick * TICK_MS);
        this.ents.set(id, e); if (kind === KIND_HORSE) this.horseOf.set(owner, e);
        if (this.onspawn) this.onspawn(e);
      },
      update: (tick, id, mask, hold, dx, dy, dz, yaw, st, gear) => {
        const e = this.ents.get(id);
        if (!e) { this.stats.unknown++; return; }
        const t = tick * TICK_MS;
        // put somewhere new (by the server, or a horse brought in by a whistle), or just out of the saddle: there is
        // no path to draw between where it was and where it is, so forget the old samples
        if ((mask & UM.PUT) || dx * dx + dz * dz > JUMP2 || (st >= 0 && (e.st & ST_RIDING) && !(st & ST_RIDING))) { e.reset(); hold = 0; }
        const before = e.newest, riding = (e.st & ST_RIDING) !== 0;
        // it stood where it was until `hold` ticks ago: say so, or it would be drawn drifting through its rest
        if (hold) e.push(t - hold * TICK_MS, dPos(e.qx), dY(e.qy), dPos(e.qz), dYaw(e.qyaw), false);
        e.qx += dx; e.qy += dy; e.qz += dz; if (yaw >= 0) e.qyaw = yaw;
        if (st >= 0) { if ((st & ST_WHISTLE) && !(e.st & ST_WHISTLE) && this.onwhistle) this.onwhistle(e); e.st = st; }
        if (gear >= 0) e.gear = gear;
        // how often it is heard of, which sets how far back it is drawn; a rider's own updates (the way they aim, the
        // gun in hand) are not movement, and they are drawn with their horse
        if (before > -Infinity && !riding) { const gap = t - (hold ? t - hold * TICK_MS : before); e.ival += ((gap > 600 ? 600 : gap) - e.ival) * 0.25; }
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
  get riding() { return this.a.riding === 1; }
  // the hour of the day in the world, 0..24
  hour(now = this.now()) { const d = (now + this.tOff + this.dayOff) % DAY_MS; return (d < 0 ? d + DAY_MS : d) / DAY_MS * 24; }

  receive(u8) {
    const st = this.stats; st.bytesIn += frameIn(u8.length);
    const r = this.r.set(u8), type = r.u8();
    if (type === MSG.SNAPSHOT) {
      if (this.state !== 'playing') return;
      if (u8.length > st.snapMax) st.snapMax = u8.length;
      st.snapshots++;
      readSnapshot(r, this.snap);
    } else if (type === MSG.PONG) {
      const sent = r.f64(), rtt = this.now() - sent, serverNow = r.f64();
      this.dayOff = r.u32() - serverNow;
      this.rtt = this.rtt ? this.rtt + (rtt - this.rtt) * 0.2 : rtt;
      if (rtt < this.rttMin) this.rttMin = rtt;
    } else if (type === MSG.WELCOME) {
      const o = decWelcome(r, this.srv);
      if (o.proto !== PROTOCOL_VERSION) { this.state = 'rejected'; this.reason = 'This page and the server are different versions.'; this.t.close(); return; }
      this.id = o.id; this.horseId = o.horseId; this.seed = o.seed; this.token = o.token; this.field = makeField(o.seed); this.tick = o.tick;
      this.dayOff = o.dayMs - o.serverNow;
      copyActor(this.a, this.srv);
      const m = this.a.f, h = this.a.h, now = this.now();
      this.prevX = this.x = m.x; this.prevY = this.y = m.y; this.prevZ = this.z = m.z; this.ox = this.oy = this.oz = 0;
      if (h) { const p = this.pH; p.x = h.x; p.y = h.y; p.z = h.z; p.hx = h.hx; p.hz = h.hz; this.oH.x = this.oH.y = this.oH.z = 0; }
      this.seq = 1; this.ack = 0; this.batch = 0; this.acc = 0; this.last = now; this.synced = false; this.tOff = o.tick * TICK_MS - now; this.hints.length = 0;
      this.remember(0);                                          // "after input 0": where the server put us
      this.ents.clear(); this.horseOf.clear();
      this.state = 'playing';
      this.place(0);
      if (this.onwelcome) this.onwelcome(o);
    } else if (type === MSG.REJECT) {
      r.u8(); this.state = 'rejected'; this.reason = r.str();
    }
  }

  // ---- reconciliation
  reconcile(tick, ack, r) {
    const now = this.now(), st = this.stats, a = this.a, m = a.f, srv = this.srv;
    readSelf(r, srv);
    this.tick = tick;
    // the clock others are drawn against: follow the average arrival, and remember how late the latest ones run
    const s = tick * TICK_MS - now;
    if (!this.synced || Math.abs(s - this.tOff) > 400) { this.tOff = s; this.jit = 0; this.synced = true; }
    else { const dev = s - this.tOff; this.tOff += dev * 0.02; const d = dev < 0 ? -dev : dev; this.jit = d > this.jit ? d : this.jit * 0.995; }
    if (this.onself) this.onself(tick, ack, srv.f.x, srv.f.y, srv.f.z);

    if (seqDiff(ack, this.ack) < 0) return;
    this.ack = ack;
    const pending = seqDiff(this.seq, ack) - 1;                  // inputs made that the server has not applied yet
    if (pending < 0 || pending >= RING) return;                  // nothing of ours to compare against
    const i0 = ack & (RING - 1), F = this.pF, o = i0 * ROW_F, ex = F[o] - srv.f.x, ey = F[o + 1] - srv.f.y, ez = F[o + 2] - srv.f.z, err = Math.sqrt(ex * ex + ey * ey + ez * ez);
    st.errLast = err; if (err > st.errMax) st.errMax = err;
    st.errs[st.errN++ & 8191] = err;
    st.errHist[err < 1e-3 ? 0 : err < 0.01 ? 1 : err < 0.05 ? 2 : err < 0.1 ? 3 : err < 0.5 ? 4 : 5]++;
    if (sameActor(srv, F, o, this.pB, i0 * ROW_B, this.pT, i0 * ROW_T, EPS)) return;
    // The server disagrees. Take its word, then run again every input it has not seen yet.
    const bx = m.x, by = m.y, bz = m.z, h0 = a.h, hbx = h0 ? h0.x : 0, hby = h0 ? h0.y : 0, hbz = h0 ? h0.z : 0;
    const c = this.cmd, keep = { mx: c.mx, mz: c.mz, yaw: c.yaw, pitch: c.pitch, buttons: c.buttons };
    copyActor(a, srv); this.remember(i0);                       // so that the same answer arriving twice is not a second surprise
    for (let q = (ack + 1) & 65535, n = pending; n > 0; n--, q = (q + 1) & 65535) {
      const i = q & (RING - 1);
      if (n === 1) this.keepPrev();
      c.mx = this.cMx[i]; c.mz = this.cMz[i]; c.yaw = this.cYaw[i]; c.pitch = this.cPitch[i]; c.buttons = this.cBtn[i];
      stepActor(a, c, this.field); this.remember(i);
    }
    if (pending === 0) this.keepPrev();
    c.mx = keep.mx; c.mz = keep.mz; c.yaw = keep.yaw; c.pitch = keep.pitch; c.buttons = keep.buttons;
    this.ox += bx - m.x; this.oy += by - m.y; this.oz += bz - m.z;
    if (this.ox * this.ox + this.oy * this.oy + this.oz * this.oz > SNAP * SNAP) this.ox = this.oy = this.oz = 0;
    const h = a.h, oh = this.oH;
    if (h && h0) { oh.x += hbx - h.x; oh.y += hby - h.y; oh.z += hbz - h.z; if (oh.x * oh.x + oh.y * oh.y + oh.z * oh.z > SNAP * SNAP) oh.x = oh.y = oh.z = 0; }
    st.corrections++;
  }
  remember(i) { packActor(this.a, this.pF, i * ROW_F, this.pB, i * ROW_B, this.pT, i * ROW_T); }
  // where things were a step ago, for drawing between steps
  keepPrev() {
    const m = this.a.f, h = this.a.h, p = this.pH;
    this.prevX = m.x; this.prevY = m.y; this.prevZ = m.z;
    if (h) { p.x = h.x; p.y = h.y; p.z = h.z; p.hx = h.hx; p.hz = h.hz; }
  }

  // ---- one input: sample, predict, remember, and send every third
  input() {
    if (seqDiff(this.seq, this.ack) > RING - 16) return;         // the server has gone quiet: stop running ahead of it
    const c = this.cmd, a = this.a, seq = this.seq, i = seq & (RING - 1);
    if (this.sample) this.sample(c, this);
    // exactly the numbers the wire carries, so both sides step with the same input
    c.mx = Math.max(-127, Math.min(127, Math.round(c.mx))) | 0; c.mz = Math.max(-127, Math.min(127, Math.round(c.mz))) | 0;
    c.yaw = Math.round(c.yaw) & 65535; c.buttons &= BTN_MASK;
    c.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.round(c.pitch || 0))) | 0;
    this.cMx[i] = c.mx; this.cMz[i] = c.mz; this.cYaw[i] = c.yaw; this.cPitch[i] = c.pitch; this.cBtn[i] = c.buttons;
    this.keepPrev();
    stepActor(a, c, this.field); this.remember(i);
    if (a.fired) {                                                // a shot, this very step: say who was under the sights, and show it
      const t = this.aimedAt(a);
      if (t && this.hints.length < PER_PACKET) this.hints.push({ seq, target: t.id, ms: Math.floor(this.now() + this.tOff - t.delay) });
      if (this.onshot) this.onshot(a, seq, t);
    }
    // a horse that was put somewhere new, or a body that got on or off one, did not travel there: do not draw the trip
    const h = a.h, p = this.pH;
    if (h) { const dx = h.x - p.x, dz = h.z - p.z; if (dx * dx + dz * dz > 25) { p.x = h.x; p.y = h.y; p.z = h.z; p.hx = h.hx; p.hz = h.hz; this.oH.x = this.oH.y = this.oH.z = 0; } }
    this.seq = (seq + 1) & 65535; this.stats.inputs++;
    if (++this.batch === PER_PACKET) {
      const w = this.w, first = (seq - (PER_PACKET - 1)) & 65535;
      encInputHead(w, first, PER_PACKET, Math.floor(this.now() + this.tOff - this.nearDelay));
      for (let k = 0; k < PER_PACKET; k++) { const j = (first + k) & (RING - 1); encCmd(w, this.cMx[j], this.cMz[j], this.cYaw[j], this.cPitch[j], this.cBtn[j]); }
      encHints(w, this.hints); this.hints.length = 0;
      this.send(w.bytes()); this.batch = 0;
    }
  }
  // Who a shot from the player's own gun went into, among everyone as they are drawn right now; or, failing that,
  // whoever it passed closest to within a metre and a half. The server judges the shot; this only tells it which
  // moment of the past to judge that person at.
  aimedAt(a) {
    let best = null, bt = 400, near = null, nd = 2.25;
    for (const e of this.ents.values()) {
      if (e.kind !== KIND_HORSE && (e.gear & GR_DEAD)) continue;
      const t = e.kind === KIND_HORSE ? rayHorse(a.ox, a.oy, a.oz, a.dx, a.dy, a.dz, e.x, e.y, e.z, e.yaw, bt) : rayPerson(a.ox, a.oy, a.oz, a.dx, a.dy, a.dz, e.x, e.y, e.z, (e.st & ST_RIDING) !== 0, bt, this.pz);
      if (t < bt) { bt = t; best = e; continue; }
      if (best || e.kind === KIND_HORSE) continue;
      const px = e.x - a.ox, py = e.y + 1.2 - a.oy, pz = e.z - a.oz, along = px * a.dx + py * a.dy + pz * a.dz;
      if (along < 0) continue;
      const d2 = px * px + py * py + pz * pz - along * along; if (d2 < nd) { nd = d2; near = e; }
    }
    return best || near;
  }

  // where to draw the player and their horse, `f` of the way from the last step to this one
  place(f) {
    const a = this.a, m = a.f, h = a.h;
    this.x = this.prevX + (m.x - this.prevX) * f + this.ox;
    this.y = this.prevY + (m.y - this.prevY) * f + this.oy;
    this.z = this.prevZ + (m.z - this.prevZ) * f + this.oz;
    if (h) {
      const p = this.pH, o = this.oH, d = this.horse;
      d.x = p.x + (h.x - p.x) * f + o.x; d.y = p.y + (h.y - p.y) * f + o.y; d.z = p.z + (h.z - p.z) * f + o.z;
      d.yaw = yawOf(p.hx + (h.hx - p.hx) * f, p.hz + (h.hz - p.hz) * f); d.sp = h.sp;
      if (a.riding) { this.x = d.x; this.y = d.y; this.z = d.z; }
    }
  }

  // ---- once per drawn frame (or per timer tick in the load test)
  frame(now = this.now()) {
    if (this.state !== 'playing') return;
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt < 0) dt = 0; else if (dt > MAX_FRAME) dt = MAX_FRAME;
    this.acc += dt;
    while (this.acc >= SIM_DT) { this.acc -= SIM_DT; this.input(); }
    const k = Math.exp(-dt / SMOOTH_TAU), o = this.oH;
    this.ox *= k; this.oy *= k; this.oz *= k; o.x *= k; o.y *= k; o.z *= k;
    this.place(this.acc / SIM_DT);

    // everyone else, each at its own distance into the past
    const est = now + this.tOff, slack = this.jit + 10, ease = 1 - Math.exp(-dt / 0.25), st = this.stats;
    this.nearDelay = Math.max(MIN_DELAY, TICK_MS + slack);
    for (const e of this.ents.values()) {
      if (e.kind !== KIND_HORSE && (e.st & ST_RIDING) && this.horseOf.has(e.id)) continue;   // riders: below, with their horses
      const dx = e.x - this.x, dz = e.z - this.z, want = Math.max(MIN_DELAY, Math.max(intervalFor(Math.sqrt(dx * dx + dz * dz)), e.ival) + slack);
      e.delay = e.delay ? e.delay + (want - e.delay) * ease : want;
      e.sample(est - e.delay);
      st.entFrames++; if (e.late > 0 && isMoving(e.st)) st.lateFrames++;
    }
    // riders go where their horses are, drawn at the same moment, and keep their own heading as the way they aim
    for (const e of this.ents.values()) {
      if (e.kind === KIND_HORSE || !(e.st & ST_RIDING)) { e.mount = null; e.aimYaw = e.yaw; continue; }
      const h = e.mount = this.horseOf.get(e.id) || null;
      if (h) { e.delay = h.delay; e.sample(est - e.delay); st.entFrames++; }
      e.aimYaw = e.yaw;
      if (h) { e.x = h.x; e.y = h.y; e.z = h.z; e.yaw = h.yaw; e.vx = h.vx; e.vz = h.vz; }
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
