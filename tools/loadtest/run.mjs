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
import { HUB_X, HUB_Z, TICK_MS, WORLD_SIZE, BAND_NEAR, BAND_MID } from '../../shared/constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), flag = n => args.includes('--' + n), opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const N = +opt('clients', 64), PING = +opt('ping', 150), JITTER = +opt('jitter', 20), QUICK = flag('quick');
const SECONDS = +opt('seconds', QUICK ? 20 : 60), SOAK = +opt('soak', 0), URL_ = opt('url', ''), PORT = +opt('port', 18200);
const BOTS = +opt('bots', 0), MAXP = +opt('max-players', Math.max(64, N + BOTS)), FPS = +opt('fps', 60), NAME = opt('name', '');
const OUT = resolve(ROOT, opt('out', 'tools/loadtest/out'));
const SCENARIOS = {
  street: { spawn: 'hub', r: 30, text: 'everyone within 30 m of one spot: the worst case for bandwidth' },
  town: { spawn: 'hub', r: 200, text: 'everyone within 200 m of the hub: a busy town' },
  spread: { spawn: 'spread', r: 150, text: 'everyone scattered over the whole map: the usual case' },
};
const wanted = SOAK ? [opt('scenario', 'town')] : opt('scenario', 'all') === 'all' ? Object.keys(SCENARIOS) : [opt('scenario')];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const r1 = v => Math.round(v * 10) / 10, r3 = v => Math.round(v * 1000) / 1000;

// someone who keeps moving: picks a spot near home, heads there at a walk, jog or sprint, sometimes strafing or
// jumping, pauses now and then, picks another
function brain(rand, radius) {
  let tx = 0, tz = 0, has = false, wait = rand() * 1.5, pace = 0, strafe = 0, left = 0;
  return (c, s) => {
    const m = s.me, home = s.home; c.mx = 0; c.mz = 0; c.buttons = 0;
    if (wait > 0) { wait -= 1 / 60; return; }
    const dx = tx - m.x, dz = tz - m.z;
    if (!has || dx * dx + dz * dz < 4 || --left < 0) {
      const a = rand() * TAU, d = Math.sqrt(rand()) * radius;
      tx = Math.min(WORLD_SIZE - 40, Math.max(40, home.x + Math.cos(a) * d)); tz = Math.min(WORLD_SIZE - 40, Math.max(40, home.z + Math.sin(a) * d));
      has = true; left = 60 * (8 + rand() * 20);
      if (rand() < 0.25) wait = 0.3 + rand() * 1.7;
      const k = rand(); pace = k < 0.15 ? BTN.WALK : k < 0.55 ? 0 : BTN.SPRINT; strafe = rand() < 0.2 ? (rand() < 0.5 ? -60 : 60) : 0;
      return;
    }
    c.yaw = Math.round((((yawOf(dx, dz) % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
    c.mz = 127; c.mx = strafe; c.buttons = pace | (rand() < 0.004 ? BTN.JUMP : 0);
  };
}

async function startServer(spawnMode) {
  if (URL_) return { url: URL_, http: URL_.replace(/^ws/, 'http'), stop() {} };
  const child = spawn(process.execPath, [...(flag('gc-at-end') ? ['--expose-gc'] : []), resolve(ROOT, 'server/src/node/main.js')], { env: { ...process.env, PORT: String(PORT), BOTS: String(BOTS), MAX_PLAYERS: String(MAXP), SPAWN: spawnMode, ALLOW_RESET: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const http = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(http + '/health')).ok) break; } catch (e) { /* not up yet */ } await sleep(50); }
  return { url: `ws://127.0.0.1:${PORT}`, http, stop: () => new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

async function scenario(name, seconds, soak) {
  const sc = SCENARIOS[name], server = await startServer(sc.spawn), rand = rng32(1899 + name.length);
  const status = async () => (await fetch(server.http + '/status')).json();
  console.log(`\n== ${name}: ${sc.text}\n   ${N} players${BOTS ? ' and ' + BOTS + ' bots' : ''}, ${PING} ms ping (${PING / 2} ms each way, plus up to ${JITTER} ms of jitter), ${seconds} s`);

  // ---- connect everyone over two seconds
  const sessions = [], byId = new Map(), TRUTH = 4096;
  for (let i = 0; i < N; i++) {
    const s = new Session(new LagTransport(new WsTransport(server.url), PING / 2, JITTER, rng32(77 + i)), { name: 'load-' + (i + 1), sample: brain(rng32(1000 + i), sc.r) });
    s.truth = new Float32Array(TRUTH * 3); s.truthTick = new Int32Array(TRUTH).fill(-1);
    s.onself = (tick, ack, x, y, z) => { const k = tick % TRUTH; s.truthTick[k] = tick; s.truth[k * 3] = x; s.truth[k * 3 + 1] = y; s.truth[k * 3 + 2] = z; };
    s.onwelcome = o => { s.home = sc.spawn === 'spread' ? { x: o.x, z: o.z } : { x: HUB_X, z: HUB_Z }; byId.set(o.id, s); };
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
    const s = byId.get(id); if (!s) return null;
    const tk = t / TICK_MS, a = Math.floor(tk), f = tk - a, i = a % TRUTH, j = (a + 1) % TRUTH;
    if (s.truthTick[i] !== a || s.truthTick[j] !== a + 1) return null;
    const p = s.truth; return [p[i * 3] + (p[j * 3] - p[i * 3]) * f, p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * f];
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
      for (let k = 0; k < 3 && list.length; k++) { const e = list[(rand() * list.length) | 0]; pending.push([e.id, now + s.tOff - e.delay, e.x, e.z, Math.hypot(e.x - s.x, e.z - s.z), now]); }
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
  const res = {
    scenario: name, about: sc.text, players: N, bots: BOTS, playing: stillPlaying, seconds: Math.round(wall), pingMs: PING, jitterMs: JITTER, measuredPingMs: Math.round(rtt / sessions.length),
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
    ['prediction within 10 cm', errMax < 0.1, `largest ${res.prediction.maxMm} mm over ${errs.length} snapshots`],
    ['everyone stayed connected', stillPlaying === N, `${stillPlaying} of ${N}`],
    ['no update for an unknown entity', unknown === 0, String(unknown)],
  ];
  if (soak) gates.push(['memory flat over the soak', rssGrow <= 20 && heapGrow <= 10, `rss ${rssGrow >= 0 ? '+' : ''}${r1(rssGrow)} MB, heap ${heapGrow >= 0 ? '+' : ''}${r1(heapGrow)} MB after the first ${Math.min(300, Math.round(seconds / 3))} s`]);
  res.gates = gates.map(([what, ok, got]) => ({ what, ok, got }));

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
