// Load test: N headless players against one server process, each on a simulated slow connection.
//
//   node tools/loadtest/run.mjs                    three one-minute scenarios, 64 players, 150 ms ping
//   node tools/loadtest/run.mjs --quick            20 s each (what CI runs)
//   node tools/loadtest/run.mjs --soak 1800        one 30-minute run, watching memory
//   node tools/loadtest/run.mjs --url wss://host   test a server that is already running somewhere
//   --bots 600 --max-players 664                   add bots to the world as stand-ins for NPCs and animals
//   --fps 20                                       how often each simulated player draws (60 by default)
//
// The players are real clients: the same Session class the game page uses, doing prediction, reconciliation and
// interpolation, over real WebSockets. Only the screen is missing. Each one wanders like a restless person.
//
// It checks the four gates from the Phase 1 plan and exits non-zero if one fails:
//   1. the server's tick takes 25 ms or less at the 99th percentile (it has 50 ms)
//   2. no player is sent more than 16 KB in any second, or sends more than 2 KB
//   3. a player's own position is predicted to within 10 cm of where the server puts it
//   4. memory is flat over a soak (only checked with --soak)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Session } from '../../client/src/net/session.js';
import { WsTransport, LagTransport } from '../../client/src/net/transport.js';
import { rng32, yawOf, TAU } from '../../shared/math.js';
import { BTN } from '../../shared/sim/moveFoot.js';
import { AIM, WEAPON_SHIFT } from '../../shared/sim/guns.js';
import { GR_DEAD, ST_RIDING } from '../../shared/constants.js';
import { HUB_X, HUB_Z, TICK_MS, WORLD_SIZE, BAND_NEAR, BAND_MID, KIND_HORSE } from '../../shared/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), flag = n => args.includes('--' + n), opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const N = +opt('clients', 64), PING = +opt('ping', 150), JITTER = +opt('jitter', 20), QUICK = flag('quick');
const SECONDS = +opt('seconds', QUICK ? 20 : 60), SOAK = +opt('soak', 0), URL_ = opt('url', ''), PORT = +opt('port', 18200);
const BOTS = +opt('bots', 0), MAXP = +opt('max-players', Math.max(64, N + BOTS)), FPS = +opt('fps', 60), NAME = opt('name', '');
const OUT = resolve(ROOT, opt('out', 'tools/loadtest/out'));
const SCENARIOS = {
  street: { spawn: 'hub', roam: 30, text: 'everyone and their horses within 30 m of one spot on the main street: the worst case for bandwidth' },
  town: { spawn: 'hub', roam: 200, text: "everyone in and around Calder's Landing: a busy town" },
  spread: { spawn: 'spread', roam: 0, text: 'everyone scattered over the whole map: the usual case' },
  gunfight: { spawn: 'hub', roam: 60, combat: true, pick: 'street', lawmen: 4, text: 'everyone in the middle of town with a gun out, shooting at whoever is nearest every few seconds, with the sheriff and his deputies (and any posse) after them: the worst case for combat' },
};
const wanted = SOAK ? [opt('scenario', 'town')] : opt('scenario', 'all') === 'all' ? Object.keys(SCENARIOS) : [opt('scenario')];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;

// Someone who keeps moving. They pick a spot, head there at a walk, jog or sprint, sometimes strafing or jumping,
// pause now and then, pick another. Two in three are riders: they whistle for their horse, get on when it arrives,
// ride at a trot, a canter or a gallop, and now and then step down and walk for a while.
// In a gunfight, each has a gun out (a revolver or a repeater) and every few seconds aims at whoever is nearest, as
// their own screen shows them, holds the aim a moment and fires.
function brain(rand, pick, rider, combat = false) {
  let tx = 0, tz = 0, has = false, wait = rand() * 1.5, pace = 0, strafe = 0, left = 0, lx = 0, lz = 0, slow = 0, n = 0;
  let afoot = rider ? 0 : 1e9, call = 0, press = 0;              // afoot: steps left before wanting the horse again
  const gun = combat ? (rand() < 0.6 ? 1 : 2) << WEAPON_SHIFT : 0; let aimFor = 0, quiet = 60 * (1 + rand() * 3), mark = null;
  const shoot = (c, s) => {                                      // returns true while it has the gun up
    if (aimFor > 0) {
      const e = mark && s.ents.get(mark), a = s.a;
      if (!e || (e.gear & GR_DEAD) || a.dead) { aimFor = 0; return false; }
      const sh = a.riding ? AIM.rideShoulder : AIM.shoulder, hd = (a.riding ? AIM.rideHead : AIM.head) + AIM.up, ty = e.y + ((e.st & ST_RIDING) ? 2.0 : 1.15);
      let yaw = c.yaw / 65536 * TAU, pitch = 0;
      for (let k = 0; k < 2; k++) { const ox = a.f.x + Math.cos(yaw) * sh, oy = a.f.y + hd, oz = a.f.z - Math.sin(yaw) * sh, dx = e.x - ox, dz = e.z - oz; yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(ty - oy, Math.hypot(dx, dz)); }
      c.yaw = Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65536) & 65535; c.pitch = Math.round(pitch / TAU * 65536);
      c.buttons |= BTN.AIM; if (--aimFor === 0) { c.buttons |= BTN.FIRE; quiet = 60 * (1.5 + rand() * 3); }
      return true;
    }
    if (--quiet > 0) return false;
    let best = null, bd = 60 * 60;
    for (const e of s.ents.values()) { if (e.kind === KIND_HORSE || (e.gear & GR_DEAD)) continue; const d = (e.x - s.x) ** 2 + (e.z - s.z) ** 2; if (d < bd) { bd = d; best = e; } }
    if (best) { mark = best.id; aimFor = 30 + (rand() * 20 | 0); } else quiet = 60;
    return false;
  };
  return (c, s) => {
    const a = s.a, m = a.f, h = a.h; c.mx = 0; c.mz = 0; c.buttons = gun;
    if (press) { press = 0; return; }                            // let go of the key, so the next press counts
    if (combat && a.slot && shoot(c, s)) return;
    if (h && !a.riding && --afoot <= 0) {                        // wants to ride: call the horse, get on when it is here
      const dx = h.x - m.x, dz = h.z - m.z;
      if (dx * dx + dz * dz < 6.2 && Math.abs(h.sp) < 3.4) { c.buttons = gun | BTN.USE; press = 1; has = false; return; }
      if (--call <= 0) { c.buttons = gun | BTN.WHISTLE; press = 1; call = 60 * 6; return; }
    }
    if (a.riding && rand() < 1 / (60 * 45)) { c.buttons = gun | BTN.USE; press = 1; afoot = 60 * (6 + rand() * 12); has = false; return; }
    if (wait > 0) { wait -= 1 / 60; return; }
    if (++n % 60 === 0) { slow = Math.hypot(m.x - lx, m.z - lz) < 0.5 ? slow + 1 : 0; lx = m.x; lz = m.z; }
    const dx = tx - m.x, dz = tz - m.z;
    if (!has || dx * dx + dz * dz < (a.riding ? 16 : 4) || --left < 0 || slow >= 2) {
      const p = pick(rand, s); tx = p[0]; tz = p[1]; has = true; slow = 0; left = 60 * (8 + rand() * 20);
      if (rand() < 0.25) wait = 0.3 + rand() * 1.7;
      const k = rand(); pace = k < 0.15 ? BTN.WALK : k < 0.55 ? 0 : BTN.SPRINT; strafe = !a.riding && rand() < 0.2 ? (rand() < 0.5 ? -60 : 60) : 0;
      return;
    }
    c.yaw = Math.round((((yawOf(dx, dz) % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
    c.mz = 127; c.mx = a.riding ? 0 : strafe; c.buttons = gun | pace | (!a.riding && rand() < 0.004 ? BTN.JUMP : 0);
  };
}
const clampW = v => Math.min(WORLD_SIZE - 40, Math.max(40, v));
const PICK = {
  // up and down thirty metres of the main street
  street: rand => [HUB_X + (rand() - 0.5) * 60, HUB_Z + (rand() - 0.5) * 12],
  // the streets of Calder's Landing, the bridge and the far bank, and now and then somewhere out of town
  town: (rand, s) => {
    const k = rand();
    if (k < 0.5) return [1894 + rand() * 206, HUB_Z + (rand() - 0.5) * 12];
    if (k < 0.65) return [1985 + (rand() - 0.5) * 9, 1970 + rand() * 160];
    if (k < 0.8) return [2110 + rand() * 120, HUB_Z + (rand() - 0.5) * 5];
    for (let i = 0; i < 8; i++) { const a = rand() * TAU, d = Math.sqrt(rand()) * 200, x = HUB_X + Math.cos(a) * d, z = HUB_Z + Math.sin(a) * d, T = s.field.terrain; if (T.levelAt(x, z) < T.heightAt(x, z)) return [x, z]; }
    return [HUB_X, HUB_Z];
  },
  // anywhere dry within 150 m of where they started
  spread: (rand, s) => {
    for (let i = 0; i < 8; i++) { const a = rand() * TAU, d = Math.sqrt(rand()) * 150, x = clampW(s.home.x + Math.cos(a) * d), z = clampW(s.home.z + Math.sin(a) * d), T = s.field.terrain; if (T.levelAt(x, z) < T.heightAt(x, z)) return [x, z]; }
    return [s.home.x, s.home.z];
  },
};

async function startServer(spawnMode, roam, lawmen = 0) {
  if (URL_) return { url: URL_, http: URL_.replace(/^ws/, 'http'), stop() {} };
  const child = spawn(process.execPath, [...(flag('gc-at-end') ? ['--expose-gc'] : []), resolve(ROOT, 'server/src/node/main.js')], { env: { ...process.env, PORT: String(PORT), BOTS: String(BOTS), MAX_PLAYERS: String(MAXP), SPAWN: spawnMode, ROAM: String(roam), LAWMEN: String(lawmen), ALLOW_RESET: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const http = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(http + '/health')).ok) break; } catch (e) { /* not up yet */ } await sleep(50); }
  return { url: `ws://127.0.0.1:${PORT}`, http, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

async function scenario(name, seconds, soak) {
  const sc = SCENARIOS[name], server = await startServer(sc.spawn, sc.roam, sc.lawmen || 0), rand = rng32(1899 + name.length);
  const status = async () => (await fetch(server.http + '/status')).json();
  console.log(`\n== ${name}: ${sc.text}\n   ${N} players${BOTS ? ' and ' + BOTS + ' bots' : ''}, ${PING} ms ping (${PING / 2} ms each way, plus up to ${JITTER} ms of jitter), ${seconds} s`);

  // ---- connect everyone over two seconds
  const sessions = [], byId = new Map(), TRUTH = 4096, PUT_BEFORE = 2, PUT_AFTER = 14;   // ticks
  for (let i = 0; i < N; i++) {
    const s = new Session(new LagTransport(new WsTransport(server.url), PING / 2, JITTER, rng32(77 + i)), { name: 'load-' + (i + 1), sample: brain(rng32(1000 + i), PICK[sc.pick || name], i % 3 !== 0, !!sc.combat) });
    s.truth = new Float32Array(TRUTH * 3); s.truthH = new Float32Array(TRUTH * 2); s.truthTick = new Int32Array(TRUTH).fill(-1);
    s.onself = (tick, ack, x, y, z) => { const k = tick % TRUTH, h = s.srv.h; s.truthTick[k] = tick; s.truth[k * 3] = x; s.truth[k * 3 + 1] = y; s.truth[k * 3 + 2] = z; if (h) { s.truthH[k * 2] = h.x; s.truthH[k * 2 + 1] = h.z; } };
    s.onwelcome = o => { s.home = sc.spawn === 'spread' ? { x: o.x, z: o.z } : { x: HUB_X, z: HUB_Z }; byId.set(o.id, [s, false]); if (o.horseId) byId.set(o.horseId, [s, true]); };
    s.peakIn = 0; s.peakOut = 0; s.lastIn = 0; s.lastOut = 0;
    sessions.push(s);
    setTimeout(() => s.open(), i * (2000 / N));
  }
  const loop = setInterval(() => { const now = performance.now(); for (const s of sessions) s.frame(now); }, Math.round(1000 / FPS));
  await sleep(2000 + (QUICK ? 5000 : 8000));                     // let them join and scatter
  const playing = sessions.filter(s => s.state === 'playing').length;
  if (playing < N) console.log(`   only ${playing} of ${N} joined:`, [...new Set(sessions.filter(s => s.state !== 'playing').map(s => s.state + ' ' + s.reason))].join('; '));

  // ---- measure
  if (!URL_) await fetch(server.http + '/reset-metrics');
  for (const s of sessions) { const st = s.stats; st.errN = 0; st.errMax = 0; st.errHist.fill(0); st.corrections = 0; st.lateFrames = 0; st.entFrames = 0; st.snapMax = 0; s.lastIn = st.bytesIn; s.lastOut = st.bytesOut; s.startIn = st.bytesIn; s.startOut = st.bytesOut; s.startSnap = st.snapshots; }
  // the clock starts at the same instant as the counters; anything awaited comes after
  const t0 = performance.now(), series = [], viewErr = { near: [], mid: [], far: [] }, pending = [], viewN = [];
  const first = await status(), tFirst = performance.now();
  const sample = (id, t) => {                                    // where the server really had entity `id` at server time t
    const rec = byId.get(id); if (!rec) return null;
    const s = rec[0], tk = t / TICK_MS, a = Math.floor(tk), f = tk - a, i = a % TRUTH, j = (a + 1) % TRUTH;
    if (s.truthTick[i] !== a || s.truthTick[j] !== a + 1) return null;
    // Something put somewhere (getting up again, the cell, out of the saddle, a horse brought in by a whistle) has no
    // "between", and a viewer shows it at its new place as soon as it hears: leave out the moments around it.
    // Nothing on legs or hooves covers a metre in a tick (a gallop is 0.85).
    const q = rec[1] ? s.truthH : s.truth, w = rec[1] ? 2 : 3;
    for (let k = a - PUT_BEFORE; k < a + PUT_AFTER; k++) { const u = k % TRUTH, v = (k + 1) % TRUTH; if (s.truthTick[u] === k && s.truthTick[v] === k + 1 && Math.hypot(q[v * w] - q[u * w], q[v * w + w - 1] - q[u * w + w - 1]) > 1) return null; }
    return [q[i * w] + (q[j * w] - q[i * w]) * f, q[i * w + w - 1] + (q[j * w + w - 1] - q[i * w + w - 1]) * f];
  };
  let lastSecond = t0;
  const every = setInterval(() => {
    const now = performance.now(), span = (now - lastSecond) / 1000; lastSecond = now;     // the timer can fire late: count by the time that really passed
    for (const s of sessions) {
      const st = s.stats, din = Math.round((st.bytesIn - s.lastIn) / span), dout = Math.round((st.bytesOut - s.lastOut) / span);
      if (din > s.peakIn) s.peakIn = din; if (dout > s.peakOut) s.peakOut = dout; s.lastIn = st.bytesIn; s.lastOut = st.bytesOut;
      // note how three of the players this one can see are drawn right now; checked against the truth a little later
      s.frame(now);
      const list = [...s.ents.values()];
      for (let k = 0; k < 3 && list.length; k++) { const e = list[(rand() * list.length) | 0]; if ((e.st & 8) && !e.mount) continue; pending.push([e.id, now + s.tOff - e.delay, e.x, e.z, Math.hypot(e.x - s.x, e.z - s.z), now]); }
    }
    while (pending.length && now - pending[0][5] > 1500) {
      const [id, t, x, z, d] = pending.shift(), tr = sample(id, t);
      if (tr) (d < BAND_NEAR ? viewErr.near : d < BAND_MID ? viewErr.mid : viewErr.far).push(Math.hypot(x - tr[0], z - tr[1]));
    }
    let v = 0; for (const s of sessions) v += s.ents.size; viewN.push(v / sessions.length);
  }, 1000);
  const poll = setInterval(async () => { try { const st = await status(); series.push({ t: Math.round((performance.now() - t0) / 1000), rssMB: st.process.rssMB, heapMB: st.process.heapMB, heapTotalMB: st.process.heapTotalMB, externalMB: st.process.externalMB, arrayBuffersMB: st.process.arrayBuffersMB, cpuMs: st.process.cpuMs, p99: st.tickMs.p99 }); if (soak && series.length % 6 === 0) console.log(`   ${String(series.at(-1).t).padStart(5)} s  rss ${st.process.rssMB} MB  heap ${st.process.heapMB} of ${st.process.heapTotalMB} MB  external ${st.process.externalMB} MB  tick p99 ${st.tickMs.p99} ms`); } catch (e) { /* server busy */ } }, soak ? 10000 : 2000);
  await sleep(seconds * 1000);
  clearInterval(every); clearInterval(poll);
  const wall = (performance.now() - t0) / 1000;
  for (const s of sessions) { s.endIn = s.stats.bytesIn; s.endOut = s.stats.bytesOut; s.endSnap = s.stats.snapshots; }
  const last = await status(), cpuWall = (performance.now() - tFirst) / 1000;
  // with --gc-at-end: ask the server for a full collection and look again, to tell memory that is merely waiting
  // to be collected from memory that is being held on to
  let afterGc = null;
  if (flag('gc-at-end') && !URL_) { await fetch(server.http + '/gc'); await sleep(1500); await fetch(server.http + '/gc'); await sleep(1500); const g = (await status()).process; afterGc = { rssMB: g.rssMB, heapMB: g.heapMB, heapTotalMB: g.heapTotalMB, externalMB: g.externalMB }; }

  // ---- add it up
  const down = sessions.map(s => (s.endIn - s.startIn) / wall).sort((a, b) => a - b), up = sessions.map(s => (s.endOut - s.startOut) / wall).sort((a, b) => a - b);
  const hist = new Array(6).fill(0); let corrections = 0, errMax = 0, late = 0, entFrames = 0, unknown = 0, errs = [], snapMax = 0, snaps = 0, rtt = 0;
  for (const s of sessions) { const st = s.stats; for (let i = 0; i < 6; i++) hist[i] += st.errHist[i]; corrections += st.corrections; if (st.errMax > errMax) errMax = st.errMax; late += st.lateFrames; entFrames += st.entFrames; unknown += st.unknown; if (st.snapMax > snapMax) snapMax = st.snapMax; snaps += s.endSnap - s.startSnap; rtt += s.rtt; const n = Math.min(st.errN, 8192); for (let i = 0; i < n; i++) errs.push(st.errs[i]); }
  errs.sort((a, b) => a - b);
  const ve = k => { const a = viewErr[k].sort((p, q) => p - q); return { n: a.length, p50cm: r1(pct(a, 0.5) * 100), p99cm: r1(pct(a, 0.99) * 100), maxCm: r1((a.at(-1) || 0) * 100) }; };
  const cpu = URL_ ? null : (last.process.cpuMs - first.process.cpuMs) / (cpuWall * 10), stillPlaying = sessions.filter(s => s.state === 'playing').length;
  const afterWarm = series.filter(p => p.t >= Math.min(300, seconds / 3)), rssGrow = afterWarm.length > 1 ? afterWarm.at(-1).rssMB - afterWarm[0].rssMB : 0, heapGrow = afterWarm.length > 1 ? afterWarm.at(-1).heapMB - afterWarm[0].heapMB : 0;
  const combat = last.combat || { shots: 0, hits: 0, kills: 0 };
  const res = {
    scenario: name, about: sc.text, combat: sc.combat ? { shots: combat.shots, hits: combat.hits, kills: combat.kills, rewoundMsMax: Math.round(combat.rewindMsMax || 0), rewoundMsAvg: combat.shots ? Math.round(combat.rewindMsSum / combat.shots) : 0, clamped: combat.clamped, eventsSent: last.totals.eventsSent, eventsDropped: last.totals.eventsDropped, law: last.law } : undefined, players: N, bots: BOTS, playing: stillPlaying, seconds: Math.round(wall), pingMs: PING, jitterMs: JITTER, measuredPingMs: Math.round(rtt / sessions.length),
    server: { tickMs: last.tickMs, cpuPercentOfOneCore: cpu === null ? null : r1(cpu), cpuPercentPerPlayer: cpu === null ? null : r3(cpu / N), rssMB: last.process.rssMB, heapMB: last.process.heapMB, rssGrowthMB: r1(rssGrow), heapGrowthMB: r1(heapGrow), biggestSnapshotBytes: last.totals.biggestSnapshot, snapshotsSkipped: last.totals.snapshotsSkipped, inputsDropped: last.totals.inputsDropped, viewDelayMs: last.viewDelayMs },
    perPlayer: {
      downBytesPerS: { avg: Math.round(down.reduce((a, b) => a + b, 0) / N), max: Math.round(down.at(-1)), peakSecond: Math.max(...sessions.map(s => s.peakIn)), peakSecondCountedByServer: last.bytesPerSecond.outPeak },
      upBytesPerS: { avg: Math.round(up.reduce((a, b) => a + b, 0) / N), max: Math.round(up.at(-1)), peakSecond: Math.max(...sessions.map(s => s.peakOut)), peakSecondCountedByServer: last.bytesPerSecond.inPeak },
      snapshotsPerS: r1(snaps / N / wall), inView: { avg: r1(viewN.reduce((a, b) => a + b, 0) / (viewN.length || 1)), max: Math.max(...sessions.map(s => s.ents.size)) },
    },
    prediction: { samples: errs.length, p50mm: r3(pct(errs, 0.5) * 1000), p99mm: r3(pct(errs, 0.99) * 1000), p999mm: r3(pct(errs, 0.999) * 1000), maxMm: r3(errMax * 1000), corrections, over1cm: hist[2] + hist[3] + hist[4] + hist[5], over10cm: hist[4] + hist[5] },
    othersDrawn: { within60m: ve('near'), to150m: ve('mid'), beyond: ve('far'), framesWaitingForAnUpdatePercent: r3(late / (entFrames || 1) * 100), unknownUpdates: unknown },
    memorySeries: soak ? series.map(p => [p.t, p.rssMB, p.heapMB, p.heapTotalMB, p.externalMB]) : undefined,
    memoryAtEnd: { rssMB: last.process.rssMB, heapMB: last.process.heapMB, heapTotalMB: last.process.heapTotalMB, externalMB: last.process.externalMB }, memoryAfterFullCollection: afterGc || undefined,
  };
  const gates = [
    ['server tick p99 <= 25 ms', last.tickMs.p99 <= 25, `${last.tickMs.p99} ms (max ${last.tickMs.max} ms)`],
    // The server counts what it sends in each second of its own ticks, which is exact. The players' own count is
    // shown too, but their one-second timer drifts when the test machine is busy.
    ['no player sent more than 16 KB in a second', last.bytesPerSecond.outPeak <= 16384, `${last.bytesPerSecond.outPeak} bytes by the server's count, ${res.perPlayer.downBytesPerS.peakSecond} by the players'`],
    ['no player sends more than 2 KB a second', last.bytesPerSecond.inPeak <= 2048, `${last.bytesPerSecond.inPeak} bytes by the server's count, ${res.perPlayer.upBytesPerS.peakSecond} by the players'`],
    // in a gunfight people are killed and stood up again elsewhere, which no client can predict; there the gate is
    // the share of snapshots that needed no correction at all
    sc.combat ? ['prediction exact in 99.5% of snapshots (deaths and respawns are not predictable)', hist[0] >= 0.995 * errs.length, `${r3(hist[0] / (errs.length || 1) * 100)}% exact; ${corrections} corrections; ${combat.kills} killed`]
      : ['prediction within 10 cm', errMax < 0.1, `largest ${res.prediction.maxMm} mm over ${errs.length} snapshots`],
    ['everyone stayed connected', stillPlaying === N, `${stillPlaying} of ${N}`],
    ['no update for an unknown entity', unknown === 0, String(unknown)],
  ];
  if (soak) gates.push(['memory flat over the soak', rssGrow <= 20 && heapGrow <= 10, `rss ${rssGrow >= 0 ? '+' : ''}${r1(rssGrow)} MB, heap ${heapGrow >= 0 ? '+' : ''}${r1(heapGrow)} MB after the first ${Math.min(300, Math.round(seconds / 3))} s`]);
  res.gates = gates.map(([what, ok, got]) => ({ what, ok, got }));

  if (sc.combat) console.log(`   combat   ${combat.shots} shots, ${combat.hits} hits, ${combat.kills} killed; rewound ${res.combat.rewoundMsAvg} ms on average, ${res.combat.rewoundMsMax} ms at most (${combat.clamped} cut back); ${last.totals.eventsSent} events sent, ${last.totals.eventsDropped} dropped`);
  if (sc.combat && last.law) { const L = last.law; console.log(`   law      ${L.crimes} crimes: ${L.seenByLaw} seen by a lawman, ${L.reported} reported by a witness, ${L.unseen} unseen; ${L.posses} posses sent (${L.posseRiding} riding at the end); ${L.arrests} arrests, ${L.jailed} jailed, ${L.escapes} got away`); }
  console.log(`   server   tick p50 ${last.tickMs.p50} ms, p99 ${last.tickMs.p99} ms, max ${last.tickMs.max} ms` + (cpu === null ? '' : `; ${r1(cpu)}% of one core (${r3(cpu / N)}% a player); rss ${last.process.rssMB} MB`));
  console.log(`   down     avg ${res.perPlayer.downBytesPerS.avg} B/s, busiest player ${res.perPlayer.downBytesPerS.max} B/s, worst second ${res.perPlayer.downBytesPerS.peakSecond} B; biggest snapshot ${last.totals.biggestSnapshot} bytes`);
  console.log(`   up       avg ${res.perPlayer.upBytesPerS.avg} B/s, worst second ${res.perPlayer.upBytesPerS.peakSecond} B`);
  console.log(`   in view  avg ${res.perPlayer.inView.avg}, most ${res.perPlayer.inView.max}; ${res.perPlayer.snapshotsPerS} snapshots/s each; others seen ${last.viewDelayMs} ms in the past`);
  console.log(`   predict  p50 ${res.prediction.p50mm} mm, p99 ${res.prediction.p99mm} mm, max ${res.prediction.maxMm} mm; ${corrections} corrections in ${errs.length} snapshots`);
  console.log(`   others   <60 m: p50 ${res.othersDrawn.within60m.p50cm} cm, p99 ${res.othersDrawn.within60m.p99cm} cm (${res.othersDrawn.within60m.n});  60-150 m: p99 ${res.othersDrawn.to150m.p99cm} cm (${res.othersDrawn.to150m.n});  beyond: p99 ${res.othersDrawn.beyond.p99cm} cm (${res.othersDrawn.beyond.n});  waiting ${res.othersDrawn.framesWaitingForAnUpdatePercent}% of frames`);
  if (afterGc) console.log(`   memory   at the end: rss ${last.process.rssMB} MB, heap ${last.process.heapMB} of ${last.process.heapTotalMB} MB, external ${last.process.externalMB} MB;  after a full collection: rss ${afterGc.rssMB} MB, heap ${afterGc.heapMB} of ${afterGc.heapTotalMB} MB, external ${afterGc.externalMB} MB`);
  for (const g of res.gates) console.log(`   ${g.ok ? 'PASS' : 'FAIL'}  ${g.what}: ${g.got}`);

  clearInterval(loop);
  for (const s of sessions) s.close();
  await sleep(200); await server.stop();
  return res;
}

const results = [];
for (const name of wanted) results.push(await scenario(name, SOAK || SECONDS, !!SOAK));
const report = { when: new Date().toISOString(), node: process.version, machine: `${os.cpus()[0]?.model || 'unknown cpu'} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB`, note: 'The players run in the same machine as the server and take CPU from it, so server timings here are pessimistic.', results };
mkdirSync(OUT, { recursive: true });
const file = resolve(OUT, (NAME || (SOAK ? 'soak' : QUICK ? 'quick' : 'report')) + '.json');
writeFileSync(file, JSON.stringify(report, null, 1));
const failed = results.flatMap(r => r.gates.filter(g => !g.ok).map(g => `${r.scenario}: ${g.what} (${g.got})`));
console.log(`\n${failed.length ? 'FAILED\n  ' + failed.join('\n  ') : 'All gates passed.'}\nReport: ${file}`);
process.exit(failed.length ? 1 : 0);
