// The authoritative world. One of these is one game world of up to 64 players: it steps every body, decides what
// each player may see, and writes each player a snapshot 20 times a second.
//
// Nothing in server/src/core uses Node: the same code runs under Node behind a WebSocket (server/src/node) and
// inside a browser tab for free solo play (client/src/net/local.js). Connections are anything with send(bytes)
// and close().
import {
  PROTOCOL_VERSION, TICK_RATE, TICK_MS, CMDS_PER_TICK, WORLD_SIZE, WORLD_SEED, HUB_X, HUB_Z, MAX_PLAYERS, DAY_MS, DAY_START_HOUR,
  VIEW_ENTER, VIEW_LEAVE, BAND_NEAR, BAND_MID, BAND_FAR, SNAPSHOT_BUDGET, KIND_PLAYER, KIND_HORSE, EF_BOT, ST_GROUND, ST_SPRINT, ST_MOVE, ST_RIDING, ST_WHISTLE,
} from '../../../shared/constants.js';
import { Writer, Reader } from '../../../shared/net/codec.js';
import { MSG, REJECT, UM, encWelcome, encReject, encPong, decHello, writeSnapshotHead, writeSpawn, spawnSize, qPos, qY, qYaw } from '../../../shared/net/messages.js';
import { makeField } from '../../../shared/world/field.js';
import { FOOT, BTN_MASK } from '../../../shared/sim/moveFoot.js';
import { HORSE, makeHorse, copyHorse } from '../../../shared/sim/moveHorse.js';
import { makeActor, stepActor, WHISTLE_HEARD } from '../../../shared/sim/actor.js';
import { SIN16, COS16 } from '../../../shared/sim/trig.js';
import { rng32, seqDiff, yawOf, TAU } from '../../../shared/math.js';
import { InterestGrid } from './interest.js';
import { Metrics } from './metrics.js';
import { Bot } from './bots.js';

export const HIST = 32;                       // ticks of position history per entity (1.6 s), for lag compensation
const QUEUE = 64;                             // inputs a player may have waiting (about a second)
const CREDIT_MAX = 30;                        // inputs a player may spend in one tick after a stall (half a second)
const CREDIT_RATE = CMDS_PER_TICK * 1.02;     // inputs earned a tick: real time, plus 2% so a fast clock is not punished
const BUFFER_MAX = 2 * CMDS_PER_TICK;         // inputs left waiting, at most, to ride out uneven arrival
const DRAIN_TICKS = 5 * TICK_RATE;            // how often a buffer that was never needed gives one input back
const GRACE_TICKS = 30 * TICK_RATE;           // a dropped player's body stays this long
const ID_REST_TICKS = 5 * TICK_RATE;          // an id is not handed out again for this long
const FLOOD = 240;                            // messages a second before a connection is closed
const ENTER2 = VIEW_ENTER * VIEW_ENTER, LEAVE2 = VIEW_LEAVE * VIEW_LEAVE;
const NEAR2 = BAND_NEAR * BAND_NEAR, MID2 = BAND_MID * BAND_MID, FAR2 = BAND_FAR * BAND_FAR;
const UPDATE_MAX = 21;                        // most bytes one entity update can take
const NEUTRAL = { mx: 0, mz: 0, yaw: 0, buttons: 0 };
const NAMES = ['Abel', 'Ada', 'Amos', 'Boone', 'Clem', 'Cora', 'Eli', 'Ezra', 'Flora', 'Gus', 'Hank', 'Hattie', 'Ike', 'Jeb', 'Josiah', 'Levi', 'Lottie', 'Mabel', 'Minnie', 'Ned', 'Nell', 'Opal', 'Otis', 'Pearl', 'Rufus', 'Ruth', 'Seth', 'Silas', 'Tess', 'Tobias', 'Vera', 'Virgil', 'Walt', 'Zeke'];
const utf8 = new TextEncoder();
const byPrio = (a, b) => b.sort - a.sort;
const cleanName = n => String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Rider';
const frameOut = n => n + (n < 126 ? 2 : 4);  // bytes on the wire for a server-to-client WebSocket frame
const frameIn = n => n + (n < 126 ? 6 : 8);   // client frames are masked: four bytes more
const sameHorse = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z && a.hx === b.hx && a.hz === b.hz && a.sp === b.sp && a.vy === b.vy && a.stam === b.stam && a.sd === b.sd && a.ground === b.ground && a.winded === b.winded && a.mode === b.mode && a.t === b.t && a.st === b.st;

export class World {
  constructor(opts = {}) {
    this.opts = Object.assign({ bots: 63, maxPlayers: MAX_PLAYERS, spawn: 'hub', roam: 0, seed: WORLD_SEED, hour: DAY_START_HOUR }, opts);
    this.now = this.opts.now || (() => performance.now());
    this.field = makeField(this.opts.seed);
    this.grid = new InterestGrid();
    this.ents = new Map(); this.list = []; this.people = []; this.bots = [];
    this.clients = new Set(); this.tokens = new Map();
    this.tick = 0; this.t0 = this.now(); this.nextT = 0; this.timer = null;
    this.dayOffset = this.opts.hour / 24 * DAY_MS;               // the hour of the day is (clock + this), wrapped
    this.nextId = 1; this.freeIds = [];
    this.rand = rng32((this.opts.seed ^ 0x51ed270b) >>> 0);
    this.metrics = new Metrics();
    this.w = new Writer(4096); this.w2 = new Writer(512); this.r = new Reader(new Uint8Array(0));
    this.mark = 0; this.tmp = []; this.cand = [];
    this.totals = { bytesOut: 0, bytesIn: 0, snapshots: 0, inputsDropped: 0, snapshotsSkipped: 0, kicked: 0, biggestSnapshot: 0 };
    this.syncBots();
  }

  serverNow() { return this.now() - this.t0; }
  dayMs() { const d = (this.serverNow() + this.dayOffset) % DAY_MS; return (d < 0 ? d + DAY_MS : d) >>> 0; }
  get humans() { return this.people.length; }
  get bodies() { return this.people.length + this.bots.length; }       // people and bots, not counting their horses

  // ---- the clock: ticks happen at t0 + n * 50 ms; a stall is not replayed, the clock is moved instead
  start() {
    if (this.timer) return;
    this.t0 = this.now() - this.tick * TICK_MS; this.nextT = this.t0 + (this.tick + 1) * TICK_MS;
    const loop = () => {
      let now = this.now(), n = 0;
      while (now >= this.nextT && n < 4) { this.step(); this.nextT += TICK_MS; n++; }
      now = this.now();
      if (now - this.nextT > 200) { this.nextT = now + TICK_MS; this.t0 = this.nextT - (this.tick + 1) * TICK_MS; }
      this.timer = setTimeout(loop, Math.max(1, this.nextT - now));
    };
    this.timer = setTimeout(loop, TICK_MS);
  }
  stop() { clearTimeout(this.timer); this.timer = null; }

  // ---- entities: people (and bots), and their horses
  allocId() {
    if (this.freeIds.length && this.tick - this.freeIds[0].at > ID_REST_TICKS) return this.freeIds.shift().id;
    if (this.nextId > 65535) throw new Error('out of entity ids');
    return this.nextId++;
  }
  entity(kind, ef, name, s, yaw) {
    const e = {
      id: this.allocId(), kind, ef, name, nameBytes: utf8.encode(name).length, s, yaw, st: ST_GROUND,
      qx: qPos(s.x), qy: qY(s.y), qz: qPos(s.z), qyaw: qYaw(yaw),
      cell: -1, gone: false, still: 2, lastChange: this.tick, restAt: this.tick, moveStart: this.tick, hist: new Float32Array(HIST * 3),
      a: null, horse: null, owner: null,
      // people only
      client: null, token: '', q: null, qHead: 0, qCount: 0, lastQueued: -1, credit: 0, ackSeq: 0, idle: 0, graceUntil: 0,
      depthMin: 99, depthAt: 0, extra: 0, hSent: null,
    };
    for (let i = 0; i < HIST; i++) { e.hist[i * 3] = s.x; e.hist[i * 3 + 1] = s.y; e.hist[i * 3 + 2] = s.z; }
    this.ents.set(e.id, e); this.list.push(e); this.grid.add(e);
    return e;
  }
  // a person at (x, z), moved out of anything solid; with a horse beside them if asked, and in its saddle if `mounted`
  spawnEntity(name, bot, x, z, horse = false, mounted = false) {
    const f = this.field, T = f.terrain, r = Math.fround;
    let y = T.heightAt(x, z);
    if (f.boxes.pushOut(x, z, FOOT.r, y + FOOT.step, y + FOOT.h)) { x = f.boxes.x; z = f.boxes.z; y = T.heightAt(x, z); }
    if (f.trees.pushOut(x, z, FOOT.r)) { x = f.trees.x; z = f.trees.z; y = T.heightAt(x, z); }
    const a = makeActor(r(x), r(y), r(z), horse), e = this.entity(KIND_PLAYER, bot ? EF_BOT : 0, name, a.f, this.rand() * TAU);
    e.a = a;
    if (horse) {
      const h = a.h, ang = (this.rand() * 65536) | 0, street = !bot && this.opts.spawn !== 'spread';
      // a newcomer on the main street finds their horse beside them on the street side, facing down it toward the
      // bridge; anyone else, a couple of paces off in any direction
      const face = street ? 49152 : (ang + 16384) & 65535;
      if (!mounted) {
        let hx = street ? x : x - SIN16[ang] * 2.2, hz = street ? z + (z > HUB_Z ? -2.4 : 2.4) : z - COS16[ang] * 2.2;
        if (f.boxes.pushOut(hx, hz, 1.2, y + HORSE.step, y + HORSE.h)) { hx = f.boxes.x; hz = f.boxes.z; }
        if (f.trees.pushOut(hx, hz, 1.2)) { hx = f.trees.x; hz = f.trees.z; }
        h.x = r(hx); h.z = r(hz); h.y = r(T.heightAt(hx, hz));
      }
      h.hx = r(-SIN16[face]); h.hz = r(-COS16[face]);
      const l = Math.sqrt(h.hx * h.hx + h.hz * h.hz); h.hx = r(h.hx / l); h.hz = r(h.hz / l);
      a.riding = mounted ? 1 : 0;
      e.horse = this.entity(KIND_HORSE, e.ef, '', h, yawOf(h.hx, h.hz)); e.horse.owner = e;
    }
    return e;
  }
  removeEntity(e) {
    if (e.gone) return;
    e.gone = true; this.grid.remove(e); this.ents.delete(e.id);
    let i = this.list.indexOf(e); if (i >= 0) this.list.splice(i, 1);
    i = this.people.indexOf(e); if (i >= 0) this.people.splice(i, 1);
    for (const c of this.clients) { const rec = c.view.get(e.id); if (rec) { c.view.delete(e.id); if (rec.known) c.gone.push(e.id); } }
    if (e.token) this.tokens.delete(e.token);
    this.freeIds.push({ id: e.id, at: this.tick });
    if (e.horse) this.removeEntity(e.horse);
  }
  // where a newcomer appears: on the main street of Calder's Landing, or anywhere dry for a scattered world
  spawnPoint() {
    const r = this.rand, T = this.field.terrain;
    if (this.opts.spawn !== 'spread') return [HUB_X + (r() - 0.5) * 44, HUB_Z + (r() - 0.5) * 9];
    for (let i = 0; i < 20; i++) { const x = 250 + r() * (WORLD_SIZE - 500), z = 250 + r() * (WORLD_SIZE - 500); if (T.levelAt(x, z) - T.heightAt(x, z) < 0.3) return [x, z]; }
    return [HUB_X, HUB_Z];
  }
  // keep the world at its bot count, making room as people arrive
  syncBots() {
    const want = Math.max(0, Math.min(this.opts.bots, this.opts.maxPlayers - this.people.length)), r = this.rand, f = this.field;
    while (this.bots.length > want) this.removeEntity(this.bots.pop().e);
    while (this.bots.length < want) {
      const n = this.bots.length, name = NAMES[n % NAMES.length] + (n >= NAMES.length ? ' ' + (1 + ((n / NAMES.length) | 0)) : ''), seed = rng32((this.opts.seed + n * 7919 + 13) >>> 0);
      let e, bot;
      if (this.opts.spawn === 'spread') {                         // scattered wanderers, a third of them mounted
        const at = this.spawnPoint(), horse = n % 3 === 0;
        e = this.spawnEntity(name, true, at[0], at[1], horse, horse); bot = new Bot(e, seed, 'wander', f, { x: at[0], z: at[1], r: 150 });
      } else if (this.opts.roam > 0) {                            // a crowd milling about the hub, for the worst-case tests
        const a = r() * TAU, d = Math.sqrt(r()) * this.opts.roam, horse = n % 3 === 0;
        e = this.spawnEntity(name, true, HUB_X + Math.cos(a) * d, HUB_Z + Math.sin(a) * d * 0.25, horse, horse); bot = new Bot(e, seed, 'wander', f, { x: HUB_X, z: HUB_Z, r: this.opts.roam });
      } else if (n % 3 === 2) {                                   // one in three rides the roads
        const roads = f.terrain.roads, rd = roads[1 + ((n / 3) | 0) % (roads.length - 1)], at = (r() * (rd.n - 1)) | 0, dir = r() < 0.5 ? 1 : -1;
        e = this.spawnEntity(name, true, rd.x[at], rd.z[at], true, true); bot = new Bot(e, seed, 'rider', f, null); bot.startOnRoad(rd, at, dir);
      } else {                                                    // the rest live somewhere: most in Calder's Landing
        const k = (n / 3) | 0, place = k % 4 === 3 ? f.places[1 + ((k / 4) | 0) % (f.places.length - 1)].id : 'hub';
        e = this.spawnEntity(name, true, HUB_X, HUB_Z, false); bot = new Bot(e, seed, 'town', f, place);
        bot.streetPoint(); const s = e.s, T = f.terrain; s.x = Math.fround(bot.tx); s.z = Math.fround(bot.tz); s.y = Math.fround(T.heightAt(s.x, s.z)); bot.wait = r() * 6;
      }
      this.bots.push(bot);
    }
  }

  // ---- connections
  connect(conn) {
    const c = { conn, player: null, view: new Map(), gone: [], fresh: true, viewDelay: 100, msgs: 0, bytesOut: 0, bytesIn: 0, outAcc: 0, outRate: 0, outPeak: 0, inAcc: 0, inRate: 0, inPeak: 0 };
    this.clients.add(c);
    return c;
  }
  disconnect(c) {
    if (!this.clients.delete(c)) return;
    const p = c.player;
    if (p) { p.client = null; c.player = null; p.graceUntil = this.tick + GRACE_TICKS; }
  }
  kick(c) { this.totals.kicked++; try { c.conn.close(); } catch (e) { /* already gone */ } this.disconnect(c); }
  send(c, bytes) {
    const n = frameOut(bytes.length);
    c.bytesOut += n; c.outAcc += n; this.totals.bytesOut += n;
    c.conn.send(bytes);
  }
  receive(c, u8) {
    if (!this.clients.has(c)) return;                           // a connection that was closed has nothing more to say
    const n = frameIn(u8.length);
    c.bytesIn += n; c.inAcc += n; this.totals.bytesIn += n;
    if (++c.msgs > FLOOD) { this.kick(c); return; }
    try {
      const r = this.r.set(u8), type = r.u8();
      if (type === MSG.INPUT) this.onInput(c, r);
      else if (type === MSG.PING) this.send(c, encPong(this.w2, r.f64(), this.serverNow(), this.dayMs()));
      else if (type === MSG.HELLO) this.onHello(c, r);
      else this.kick(c);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      this.kick(c);                                              // a message that does not parse ends the connection
    }
  }
  onHello(c, r) {
    if (c.player) return;
    const h = decHello(r);
    if (h.proto !== PROTOCOL_VERSION) { this.send(c, encReject(this.w2, REJECT.VERSION, 'This page is out of date. Reload it to play.')); this.kick(c); return; }
    let p = h.token ? this.tokens.get(h.token) : null;
    if (p && p.gone) p = null;
    if (p && p.client) {                                         // the same player on a new connection: the old one is closed
      const old = p.client; old.player = null; p.client = null;
      this.clients.delete(old); try { old.conn.close(); } catch (e) { /* already gone */ }
    }
    if (!p) {
      if (this.people.length >= this.opts.maxPlayers) { this.send(c, encReject(this.w2, REJECT.FULL, 'This world is full.')); this.kick(c); return; }
      // a bot steps aside first, so the newcomer's id is not one a client still shows
      if (this.bots.length && this.people.length + this.bots.length >= this.opts.maxPlayers) this.removeEntity(this.bots.pop().e);
      const at = this.spawnPoint();
      p = this.spawnEntity(cleanName(h.name), false, at[0], at[1], true);
      p.q = Array.from({ length: QUEUE }, () => ({ seq: 0, mx: 0, mz: 0, yaw: 0, buttons: 0 }));
      const b = new Uint8Array(12); globalThis.crypto.getRandomValues(b);
      p.token = Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
      this.tokens.set(p.token, p); this.people.push(p);
    }
    p.client = c; c.player = p; c.fresh = true;
    p.graceUntil = 0; p.qHead = 0; p.qCount = 0; p.lastQueued = -1; p.credit = CMDS_PER_TICK; p.ackSeq = 0; p.idle = 0;
    p.depthMin = 99; p.depthAt = this.tick; p.extra = 0;
    p.hSent = p.a.h ? copyHorse(p.hSent || makeHorse(), p.a.h) : null;      // the welcome carries the horse in full
    this.syncBots();
    this.send(c, encWelcome(this.w2, { id: p.id, tickRate: TICK_RATE, tick: this.tick, serverNow: this.serverNow(), dayMs: this.dayMs(), seed: this.opts.seed, token: p.token, horseId: p.horse ? p.horse.id : 0, actor: p.a }));
  }
  onInput(c, r) {
    const p = c.player; if (!p) return;
    let seq = r.u16();
    c.viewDelay = (Math.floor(this.serverNow()) - r.u16()) & 65535;     // how far in the past this player sees the world, ms
    const n = r.u8(); if (n > 12) throw new RangeError('too many inputs in one packet');
    for (let i = 0; i < n; i++, seq = (seq + 1) & 65535) {
      const mx = r.i8(), mz = r.i8(), yaw = r.u16(), buttons = r.u8();
      if (p.lastQueued >= 0 && seqDiff(seq, p.lastQueued) <= 0) continue;        // already have it
      if (p.qCount === QUEUE) { p.qHead = (p.qHead + 1) % QUEUE; p.qCount--; this.totals.inputsDropped++; }
      const q = p.q[(p.qHead + p.qCount) % QUEUE]; p.qCount++;
      q.seq = seq; q.mx = mx < -127 ? -127 : mx; q.mz = mz < -127 ? -127 : mz; q.yaw = yaw; q.buttons = buttons & BTN_MASK;
      p.lastQueued = seq;
    }
  }

  // ---- one tick
  step() {
    const t0 = this.now(), tick = ++this.tick, field = this.field, t = tick / TICK_RATE;

    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i]; b.think(t);
      for (let k = 0; k < CMDS_PER_TICK; k++) stepActor(b.e.a, b.cmd, field);
    }
    let expired = null;
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      if (!p.client) {                                           // dropped: the body comes to rest and waits out its grace
        if (tick >= p.graceUntil) (expired || (expired = [])).push(p);
        else for (let k = 0; k < CMDS_PER_TICK; k++) stepActor(p.a, NEUTRAL, field);
        continue;
      }
      // Each input is worth 1/60 s. A player earns three a tick, so nobody moves faster than time for long.
      p.credit = Math.min(p.credit + CREDIT_RATE, CREDIT_MAX);
      // Inputs arrive in bursts on a real connection: none this tick, two packets the next. Taking three a tick and
      // leaving up to two packets waiting keeps the body moving evenly for everyone watching it. A deeper queue
      // than that is caught up at once, and a buffer that went unused for five seconds is handed back one input
      // at a time, so the delay it adds does not stay for good.
      let n = p.qCount; const spare = n - CMDS_PER_TICK;
      if (spare > BUFFER_MAX) n = spare;
      else if (spare > 0) n = CMDS_PER_TICK + p.extra;
      p.extra = 0;
      if (n > p.credit) n = Math.floor(p.credit);
      p.credit -= n;
      if (p.qCount - n < p.depthMin) p.depthMin = p.qCount - n;
      if (tick - p.depthAt >= DRAIN_TICKS) { if (p.depthMin >= CMDS_PER_TICK) p.extra = 1; p.depthMin = 99; p.depthAt = tick; }
      if (n === 0) { if (++p.idle > 10) for (let k = 0; k < CMDS_PER_TICK; k++) stepActor(p.a, NEUTRAL, field); continue; }
      p.idle = 0;
      while (n--) { const q = p.q[p.qHead]; p.qHead = (p.qHead + 1) % QUEUE; p.qCount--; stepActor(p.a, q, field); p.ackSeq = q.seq; }
    }
    if (expired) { for (const p of expired) this.removeEntity(p); this.syncBots(); }

    // what everyone else will be told about each body, and where it was (for rewinding later)
    const hi = (tick % HIST) * 3;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i], s = e.s;
      this.grid.move(e);
      let qx = e.qx, qy = e.qy, qz = e.qz, qyaw = e.qyaw, st;
      if (e.kind === KIND_HORSE) {
        const sp = s.sp < 0 ? -s.sp : s.sp;
        qx = qPos(s.x); qy = qY(s.y); qz = qPos(s.z); qyaw = qYaw(e.yaw = yawOf(s.hx, s.hz));
        st = (s.ground ? ST_GROUND : 0) | (sp > HORSE.canter + 1.5 ? ST_SPRINT : 0) | (sp > 0.3 ? ST_MOVE : 0);
      } else {
        const a = e.a;
        if (a.riding) st = ST_RIDING | ST_GROUND;                 // in the saddle: drawn on the horse, so nothing of their own to send
        else {
          const sp2 = s.vx * s.vx + s.vz * s.vz;
          if (sp2 > 0.16) e.yaw = yawOf(s.vx, s.vz);
          qx = qPos(s.x); qy = qY(s.y); qz = qPos(s.z); qyaw = qYaw(e.yaw);
          st = (s.ground ? ST_GROUND : 0) | (sp2 > 30 ? ST_SPRINT : 0) | (sp2 > 0.09 ? ST_MOVE : 0);
        }
        if (a.whT > WHISTLE_HEARD) st |= ST_WHISTLE;
      }
      if (qx !== e.qx || qy !== e.qy || qz !== e.qz || qyaw !== e.qyaw || st !== e.st) {
        if (e.still >= 2) { e.restAt = e.lastChange; e.moveStart = tick; }
        e.still = 0; e.lastChange = tick;
        e.qx = qx; e.qy = qy; e.qz = qz; e.qyaw = qyaw; e.st = st;
      } else e.still++;
      const h = e.hist; h[hi] = s.x; h[hi + 1] = s.y; h[hi + 2] = s.z;
    }

    for (const c of this.clients) if (c.player) this.sendSnapshot(c, tick);

    if (tick % TICK_RATE === 0) {
      for (const c of this.clients) {
        c.outRate = c.outAcc; if (c.outAcc > c.outPeak) c.outPeak = c.outAcc; c.outAcc = 0;
        c.inRate = c.inAcc; if (c.inAcc > c.inPeak) c.inPeak = c.inAcc; c.inAcc = 0;
        c.msgs = 0;
      }
    }
    this.metrics.tick(this.now() - t0);
  }

  // ---- who a player can see: in at 384 m, out at 448 m, rebuilt four times a second
  refreshView(c) {
    const me = c.player, s = me.s, tmp = this.tmp, mark = ++this.mark;
    tmp.length = 0; this.grid.query(s.x, s.z, VIEW_LEAVE, tmp);
    for (let i = 0; i < tmp.length; i++) {
      const e = tmp[i]; if (e === me || e === me.horse) continue;                // a player's own horse comes with their own state
      const dx = e.s.x - s.x, dz = e.s.z - s.z, d2 = dx * dx + dz * dz, rec = c.view.get(e.id);
      if (rec) { if (d2 <= LEAVE2) rec.mark = mark; }
      else if (d2 <= ENTER2) c.view.set(e.id, { e, known: false, qx: 0, qy: 0, qz: 0, yaw: 0, st: 0, prio: 1, sent: 0, sort: 0, mark });
    }
    for (const [id, rec] of c.view) if (rec.mark !== mark) { c.view.delete(id); if (rec.known) c.gone.push(id); }
  }

  // ---- one snapshot: own state, who left, who arrived, then the most overdue updates until the budget is spent
  sendSnapshot(c, tick) {
    if (c.conn.buffered > 65536) { this.totals.snapshotsSkipped++; return; }   // the socket is backed up: do not pile on
    const p = c.player, s = p.s, w = this.w, B = SNAPSHOT_BUDGET, h = p.a.h;
    // the horse goes along whenever anything about it has changed since this player was last told
    const withHorse = !!h && !sameHorse(h, p.hSent);
    if (withHorse) copyHorse(p.hSent, h);
    writeSnapshotHead(w, tick, p.ackSeq, p.a, withHorse);
    if (c.fresh || (tick + p.id) % 5 === 0) { this.refreshView(c); c.fresh = false; }

    let at = w.o, n = 0; w.u8(0);
    const gone = c.gone;
    while (n < gone.length && n < 255 && w.o + 2 <= B - 2) { w.u16(gone[n]); n++; }
    if (n) { gone.splice(0, n); w.setU8(at, n); }

    // Everything in view earns priority each tick, faster the nearer it is. Whatever has earned a full point and
    // has something new to say is a candidate; a body standing still says nothing and costs nothing.
    const cand = this.cand; cand.length = 0; let fresh = 0;
    for (const rec of c.view.values()) {
      const e = rec.e, dx = e.s.x - s.x, dz = e.s.z - s.z, d2 = dx * dx + dz * dz;
      rec.prio += d2 < NEAR2 ? 1 : d2 < MID2 ? 0.5 : d2 < FAR2 ? 0.25 : 0.1;
      if (rec.prio > 4) rec.prio = 4;
      if (rec.prio < 1) continue;
      if (!rec.known) { rec.sort = 100 - d2 * 1e-4; cand.push(rec); fresh++; }
      else if (e.qx !== rec.qx || e.qz !== rec.qz || e.qy !== rec.qy || e.qyaw !== rec.yaw || e.st !== rec.st) { rec.sort = rec.prio; cand.push(rec); }
    }
    if (cand.length > 1) cand.sort(byPrio);

    // arrivals, nearest first, using at most 60% of what is left so that those already in view still move
    at = w.o; n = 0; w.u8(0);
    if (fresh) {
      const limit = w.o + Math.floor((B - w.o) * 0.6);
      for (let i = 0; i < cand.length; i++) {
        const rec = cand[i]; if (rec.known) break;
        const e = rec.e; if (n === 255 || w.o + spawnSize(e) > limit) break;
        writeSpawn(w, e);
        rec.known = true; rec.qx = e.qx; rec.qy = e.qy; rec.qz = e.qz; rec.yaw = e.qyaw; rec.st = e.st; rec.prio = 0; rec.sent = tick; rec.sort = -1; n++;
      }
      w.setU8(at, n);
    }

    at = w.o; n = 0; w.u8(0);
    for (let i = 0; i < cand.length; i++) {
      const rec = cand[i]; if (!rec.known || rec.sort < 0) continue;
      if (n === 255 || w.o + UPDATE_MAX > B) break;
      const e = rec.e, dx = e.qx - rec.qx, dy = e.qy - rec.qy, dz = e.qz - rec.qz;
      let mask = (dx || dy || dz ? UM.POS : 0) | (e.qyaw !== rec.yaw ? UM.YAW : 0) | (e.st !== rec.st ? UM.STATE : 0), hold = 0;
      // If this body stood still since before the last thing this player heard about it, say how long ago it set
      // off, so their copy does not start drifting before the real one moved.
      if (rec.sent >= e.restAt && rec.sent < e.moveStart - 1) { hold = Math.min(255, tick - (e.moveStart - 1)); if (hold > 0) mask |= UM.HOLD; }
      w.u16(e.id); w.u8(mask);
      if (mask & UM.HOLD) w.u8(hold);
      if (mask & UM.POS) { w.vari(dx); w.vari(dz); w.vari(dy); }
      if (mask & UM.YAW) w.u8(e.qyaw);
      if (mask & UM.STATE) w.u8(e.st);
      rec.qx = e.qx; rec.qy = e.qy; rec.qz = e.qz; rec.yaw = e.qyaw; rec.st = e.st; rec.prio = 0; rec.sent = tick; n++;
    }
    if (n) w.setU8(at, n);

    if (w.o > this.totals.biggestSnapshot) this.totals.biggestSnapshot = w.o;
    this.totals.snapshots++;
    this.send(c, w.bytes());
  }

  // ---- where a body was at an earlier tick (fractions allowed). Used for lag compensation from Phase 4.
  positionAt(e, tick, out) {
    const newest = this.tick, oldest = newest - (HIST - 1);
    const t = tick > newest ? newest : tick < oldest ? oldest : tick, a = Math.floor(t), f = t - a;
    const h = e.hist, i = (((a % HIST) + HIST) % HIST) * 3, j = ((((a + 1) % HIST) + HIST) % HIST) * 3;
    if (f <= 0 || a + 1 > newest) { out.x = h[i]; out.y = h[i + 1]; out.z = h[i + 2]; }
    else { out.x = h[i] + (h[j] - h[i]) * f; out.y = h[i + 1] + (h[j + 1] - h[i + 1]) * f; out.z = h[i + 2] + (h[j + 2] - h[i + 2]) * f; }
    return out;
  }

  // forget the peaks and timings so far, so a measurement can start clean
  resetMetrics() {
    this.metrics.reset();
    for (const c of this.clients) { c.outPeak = 0; c.inPeak = 0; }
    Object.assign(this.totals, { inputsDropped: 0, snapshotsSkipped: 0, biggestSnapshot: 0 });
  }
  status() {
    let n = 0, out = 0, peak = 0, inn = 0, inPeak = 0, view = 0, delay = 0;
    for (const c of this.clients) if (c.player) { n++; out += c.outRate; inn += c.inRate; delay += c.viewDelay; if (c.outPeak > peak) peak = c.outPeak; if (c.inPeak > inPeak) inPeak = c.inPeak; if (c.view.size > view) view = c.view.size; }
    return {
      protocol: PROTOCOL_VERSION, tick: this.tick, tickRate: TICK_RATE, uptimeS: Math.round(this.serverNow() / 1000), hour: Math.round(this.dayMs() / DAY_MS * 240) / 10,
      people: this.people.length, connected: n, bots: this.bots.length, entities: this.list.length, maxPlayers: this.opts.maxPlayers,
      tickMs: this.metrics.summary(),
      bytesPerSecond: { outAvg: n ? Math.round(out / n) : 0, outPeak: peak, inAvg: n ? Math.round(inn / n) : 0, inPeak },
      biggestView: view, viewDelayMs: n ? Math.round(delay / n) : 0, totals: this.totals,
    };
  }
}
