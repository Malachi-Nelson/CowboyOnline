// The client half, end to end against a real world: prediction, correction, and how other players are drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.js';
import { rng32 } from '../shared/math.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { HORSE } from '../shared/sim/moveHorse.js';
import { ROW_F, ROW_B } from '../shared/sim/actor.js';
import { HUB_X, HUB_Z, TICK_MS, ST_MOVE, ST_RIDING, KIND_HORSE, KIND_PLAYER } from '../shared/constants.js';

const WEST = 16384, EAST = 49152, NORTH = 0;
// a player who wanders: turns, strafes, sprints, stops and jumps, the same way every run; `horse` adds whistling for
// the horse and getting on and off it at odd moments
const wander = (seed, horse = false) => {
  const r = rng32(seed); let n = 0, yaw = r() * 65536, mx = 0, mz = 127, b = 0;
  return c => {
    if (n++ % 45 === 0) { yaw += (r() - 0.5) * 30000; mx = r() < 0.3 ? (r() < 0.5 ? -127 : 127) : 0; mz = r() < 0.15 ? 0 : r() < 0.1 ? -127 : 127; b = r() < 0.5 ? BTN.SPRINT : r() < 0.2 ? BTN.WALK : 0; }
    c.mx = mx; c.mz = mz; c.yaw = yaw; c.buttons = b | (r() < 0.01 ? BTN.JUMP : 0) | (horse && r() < 0.004 ? BTN.WHISTLE : 0) | (horse && r() < 0.006 ? BTN.USE : 0);
  };
};
const hold = (yaw, buttons = 0, mz = 127) => c => { c.mx = 0; c.mz = mz; c.yaw = yaw; c.buttons = buttons; };
const person = (r, name) => r.world.people.find(p => p.name === name);
// stand a player in the middle of the main street with their horse beside them
const onStreet = (r, p, dx = 0) => { const s = p.s, h = p.a.h; s.x = Math.fround(HUB_X + dx); s.z = HUB_Z; s.y = r.world.field.base; s.vx = s.vz = 0; h.x = s.x; h.z = Math.fround(HUB_Z + 2); h.y = s.y; h.sp = 0; h.hx = -1; h.hz = 0; p.a.riding = 0; };

test('prediction agrees with the server at 160 ms of ping with jitter: on foot, among buildings, with jumps', () => {
  const r = rig(), jit = rng32(5);
  const s = r.join('Ada', () => 80 + jit() * 25, { sample: wander(11) });
  r.run(60000);
  const st = s.stats;
  assert.equal(s.state, 'playing');
  assert.ok(st.snapshots > 1100 && st.inputs > 3500, `${st.snapshots} snapshots, ${st.inputs} inputs`);
  assert.equal(st.corrections, 0, 'never corrected');
  assert.equal(st.errMax, 0, 'client and server agree to the last bit');
  assert.ok(s.rtt > 160 && s.rtt < 215, `ping reads ${s.rtt.toFixed(0)} ms`);
  const p = r.world.people[0], d = Math.hypot(p.s.x - HUB_X, p.s.z - HUB_Z);
  assert.ok(d > 3, 'and it went somewhere');
});

test('prediction agrees with the server through whistles, mounting, riding, swimming and stepping down', () => {
  const r = rig({ bots: 20 }), jit = rng32(6);
  const s = r.join('Ada', () => 80 + jit() * 25, { sample: wander(11, true) });
  let rode = 0, changes = 0, was = 0, whistles = 0, wh = 0, wet = 0; const T = r.world.field.terrain;
  for (let i = 0; i < 240; i++) {
    r.run(1000); const a = s.a;
    if (a.riding) rode++; if (a.riding !== was) { changes++; was = a.riding; }
    if (T.levelAt(a.f.x, a.f.z) - a.f.y > 1) wet++;
  }
  const p = r.world.people[0];
  assert.equal(s.stats.corrections, 0, 'never corrected'); assert.equal(s.stats.errMax, 0);
  assert.ok(rode > 20 && changes >= 6, `rode for ${rode} s, in and out of the saddle ${changes} times`);
  assert.equal(s.a.h.x, p.a.h.x); assert.equal(s.a.h.z, p.a.h.z); assert.equal(s.a.h.stam, p.a.h.stam); assert.equal(s.a.riding, p.a.riding);
  assert.equal(s.horseId, p.horse.id);
  assert.ok(!s.ents.has(s.horseId), 'the player is not sent their own horse as somebody else');
});

test('when the server disagrees the player is put right, and the view glides there', () => {
  const r = rig();
  const s = r.join('Ada', 60, { sample: hold(WEST, BTN.SPRINT) });
  r.run(200); onStreet(r, person(r, 'Ada'), 60); r.run(2800);
  const p = r.world.people[0], base = s.stats.corrections;
  p.s.z += 1.5;                                                   // the server knows something the client did not predict
  let glided = false, jumped = 0, before = s.z;
  for (let i = 0; i < 60; i++) { r.run(16); const dz = Math.abs(s.z - before); if (dz > jumped) jumped = dz; before = s.z; if (s.stats.corrections > base && Math.abs(s.oz) > 0.2) glided = true; }
  assert.equal(s.stats.corrections, base + 1);
  assert.ok(glided, 'the correction was spread over several frames');
  assert.ok(jumped < 0.45, `largest single-frame shift ${jumped.toFixed(2)} m of a 1.5 m correction`);
  r.run(2000);
  // prediction is back in step with the server: nothing further to correct, and no offset left
  assert.equal(s.stats.corrections, base + 1);
  assert.ok(Math.abs(s.oz) < 1e-3);
  assert.ok(s.stats.errLast < 0.001);
  // the same when it is the horse the server knows better about
  p.a.h.x += 2; r.run(1500);
  assert.equal(s.stats.corrections, base + 2); assert.equal(s.a.h.x, p.a.h.x);
});

test('another player is drawn where they really were, a tenth of a second ago', () => {
  const r = rig(), j1 = rng32(3), j2 = rng32(4);
  const a = r.join('Ada', () => 40 + j1() * 15, { sample: wander(21) });
  const b = r.join('Boone', () => 70 + j2() * 20, { sample: () => {} });       // stands and watches
  r.run(2000);
  const pa = person(r, 'Ada'), truth = [];
  let worst = 0, sum = 0, n = 0, late = 0;
  for (let i = 0; i < 1200; i++) {
    r.run(50); truth[r.world.tick] = { x: pa.s.x, y: pa.s.y, z: pa.s.z };
    b.frame(r.clock.t);
    const e = b.ents.get(a.id); assert.ok(e, 'Boone can see Ada');
    const rt = (r.clock.t + b.tOff - e.delay) / TICK_MS, k = Math.floor(rt), f = rt - k, t0 = truth[k], t1 = truth[k + 1];
    if (!t0 || !t1) continue;
    const err = Math.hypot(e.x - (t0.x + (t1.x - t0.x) * f), e.z - (t0.z + (t1.z - t0.z) * f));
    if (err > worst) worst = err; sum += err; n++; if (e.late > 0 && (e.st & ST_MOVE)) late++;
    assert.ok(e.delay >= 100 && e.delay < 180, `drawn ${e.delay.toFixed(0)} ms in the past`);
  }
  assert.ok(n > 1100);
  assert.ok(sum / n < 0.03, `average error ${(sum / n * 100).toFixed(1)} cm`);
  assert.ok(worst < 0.25, `worst error ${(worst * 100).toFixed(1)} cm`);
  assert.ok(late / n < 0.02, `ran out of samples in ${(late / n * 100).toFixed(1)}% of frames`);
});

test('a rider is drawn on their horse, at a gallop, to within a hand; and beside it the moment they step down', () => {
  const r = rig(), j1 = rng32(8), j2 = rng32(9);
  let phase = 0, press = 0;
  const a = r.join('Ada', () => 40 + j1() * 15, { sample: c => { c.mx = 0; c.mz = phase === 1 ? 127 : 0; c.yaw = WEST; c.buttons = (phase === 1 ? BTN.SPRINT : 0) | (press > 0 ? (press--, BTN.USE) : 0); } });
  const b = r.join('Boone', () => 70 + j2() * 20, { sample: () => {} });
  r.run(300); const pa = person(r, 'Ada'), pb = person(r, 'Boone'); onStreet(r, pa, 55); onStreet(r, pb, 20); pb.s.z += 5;
  r.run(1500); assert.equal(a.stats.corrections, 1, 'being moved by the server is one correction, however the snapshots fall'); press = 2; r.run(600);
  assert.equal(pa.a.riding, 1, 'Ada is in the saddle');
  const e = b.ents.get(a.id), he = b.ents.get(pa.horse.id); assert.ok(e && he && he.kind === KIND_HORSE && he.owner === a.id);
  assert.ok(e.st & ST_RIDING); assert.equal(e.mount, he, 'Boone draws her on her horse');
  phase = 1; const truth = []; let worst = 0, n = 0, top = 0;
  for (let i = 0; i < 150; i++) {
    r.run(50); truth[r.world.tick] = { x: pa.a.h.x, z: pa.a.h.z }; b.frame(r.clock.t);
    const rt = (r.clock.t + b.tOff - he.delay) / TICK_MS, k = Math.floor(rt), f = rt - k, t0 = truth[k], t1 = truth[k + 1];
    if (!t0 || !t1) continue;
    const err = Math.hypot(he.x - (t0.x + (t1.x - t0.x) * f), he.z - (t0.z + (t1.z - t0.z) * f)); if (err > worst) worst = err; n++;
    assert.equal(e.x, he.x); assert.equal(e.z, he.z);
    if (pa.a.h.sp > top) top = pa.a.h.sp;
  }
  assert.ok(n > 120 && top > 12.9, `galloped (${top.toFixed(1)} m/s)`);
  assert.ok(worst < 0.3, `the horse was drawn within ${(worst * 100).toFixed(0)} cm of where it was`);
  // rein in and step down: Ada is drawn beside the horse at once, not sliding there from where she mounted
  phase = 2; r.run(4000); press = 2; r.run(120); b.frame(r.clock.t);
  assert.equal(pa.a.riding, 0); let far = 0;
  // until the news reaches Boone she is still on the horse; after it she is beside it. Never anywhere else.
  for (let i = 0; i < 30; i++) { r.run(16); b.frame(r.clock.t); const d = Math.hypot(e.x - pa.s.x, e.z - pa.s.z); if (d > far) far = d; }
  assert.equal(e.mount, null); assert.ok(far < 1.3, `never drawn more than ${far.toFixed(2)} m from where she stands`);
  assert.ok(Math.hypot(e.x - pa.s.x, e.z - pa.s.z) < 0.05, 'and ends up exactly there');
  assert.equal(a.stats.corrections, 1, 'and nothing after it'); assert.equal(b.stats.unknown, 0);
});

test('a horse called from far off appears where it was brought in, without streaking across the map', () => {
  const r = rig();
  let press = 0;
  const a = r.join('Ada', 30, { sample: c => { c.mx = 0; c.mz = 0; c.yaw = NORTH; c.buttons = press > 0 ? (press--, BTN.WHISTLE) : 0; } });
  const b = r.join('Boone', 30, { sample: () => {} });
  r.run(300); const pa = person(r, 'Ada'), pb = person(r, 'Boone'); onStreet(r, pa, 0); onStreet(r, pb, 10);
  pa.a.h.x = Math.fround(HUB_X - 140); r.run(1500);              // Ada's horse is 140 m up the street; both can see it
  const he = b.ents.get(pa.horse.id), base = a.stats.corrections; assert.ok(he); let heard = 0; b.onwhistle = e => { if (e.id === a.id) heard++; };
  press = 2; let streak = 0, last = { x: he.x, z: he.z }, jumps = 0;
  for (let i = 0; i < 600; i++) {
    r.run(16); b.frame(r.clock.t);
    const step = Math.hypot(he.x - last.x, he.z - last.z); last = { x: he.x, z: he.z };
    if (step > 20) jumps++; else if (step > 1.2) streak++;        // 1.2 m in a 16 ms frame would be 75 m/s
  }
  assert.equal(heard, 1, 'Boone hears the whistle once');
  assert.equal(jumps, 1, 'the horse is seen to change place once');
  assert.equal(streak, 0, 'and is never drawn travelling between the two places');
  assert.ok(Math.hypot(he.x - pa.s.x, he.z - pa.s.z) < HORSE.reach + 0.5, 'then runs to Ada');
  assert.equal(a.stats.corrections, base, 'and Ada predicted all of it');
});

test('someone far off who has been standing still does not drift before they set off', () => {
  const r = rig();
  let go = false;
  const a = r.join('Ada', 30, { sample: c => { c.mx = 0; c.mz = go ? 127 : 0; c.yaw = EAST; c.buttons = BTN.SPRINT; } });
  const b = r.join('Boone', 30, { sample: () => {} });
  r.run(500);
  const pa = person(r, 'Ada'), pb = person(r, 'Boone'); onStreet(r, pa, -100);
  pb.s.x = pa.s.x - 250; pb.s.z = pa.s.z;                         // 250 m apart: Boone hears about Ada five times a second
  r.run(8000);
  const e = b.ents.get(a.id), restX = pa.s.x; assert.ok(e);
  assert.ok(Math.abs(e.x - restX) < 0.05);
  go = true;
  let started = 0, driftBefore = 0; const truth = [];
  for (let i = 0; i < 40; i++) {
    r.run(50); truth[r.world.tick] = pa.s.x; if (!started && pa.s.x - restX > 0.01) started = r.world.tick;
    b.frame(r.clock.t);
    const rt = (r.clock.t + b.tOff - e.delay) / TICK_MS;
    if (!started || rt < started - 1) driftBefore = Math.max(driftBefore, Math.abs(e.x - restX));
  }
  assert.ok(started > 0, 'Ada set off');
  assert.ok(driftBefore < 0.05, `drawn ${(driftBefore * 100).toFixed(1)} cm from rest before the moment it really moved`);
  assert.ok(e.x - restX > 3, 'and then it is drawn running');
  assert.ok(e.delay > 200 && e.delay < 300, `at that range it is drawn ${e.delay.toFixed(0)} ms in the past`);
});

test('walking out of range and back: forgotten, then met again', () => {
  const r = rig();
  const a = r.join('Ada', 20, { sample: () => {} }), b = r.join('Boone', 20, { sample: () => {} });
  const seen = [];
  b.onspawn = e => { if (e.kind === KIND_PLAYER) seen.push('met ' + e.name); }; b.ondespawn = e => { if (e.kind === KIND_PLAYER) seen.push('lost ' + e.name); };
  r.run(600);
  const pa = person(r, 'Ada'), x = pa.s.x;
  pa.s.x = x + 600; r.run(600); assert.ok(!b.ents.has(a.id)); assert.ok(b.ents.has(pa.horse.id), 'her horse stayed behind, and is still in sight');
  pa.s.x = x; r.run(600); assert.ok(b.ents.has(a.id));
  assert.deepEqual(seen, ['met Ada', 'lost Ada', 'met Ada']);
  assert.equal(b.stats.unknown, 0);
});

test('input numbers wrap at 65,536 without a hiccup', () => {
  const r = rig();
  const s = r.join('Ada', 0, { sample: wander(31, true) });
  r.run(1300); r.flush();
  // jump to just short of the wrap, on both sides, as if 18 minutes had passed
  const p = r.world.people[0];
  const shift = (65400 - s.seq) & 65535;
  s.seq = (s.seq + shift) & 65535; s.ack = (s.ack + shift) & 65535; p.ackSeq = (p.ackSeq + shift) & 65535; p.lastQueued = (p.lastQueued + shift) & 65535;
  for (let i = 0; i < p.q.length; i++) p.q[i].seq = (p.q[i].seq + shift) & 65535;
  for (const [k, row] of [['cMx', 1], ['cMz', 1], ['cYaw', 1], ['cBtn', 1], ['pF', ROW_F], ['pB', ROW_B], ['pT', 1]]) { const src = s[k].slice(), n = src.length / row; for (let i = 0; i < n; i++) for (let c = 0; c < row; c++) s[k][((i + shift) & (n - 1)) * row + c] = src[i * row + c]; }
  r.run(8000);
  assert.ok(s.seq < 1000, `wrapped (now at ${s.seq})`);
  assert.equal(s.stats.corrections, 0, 'no correction on the way through');
  assert.equal(s.stats.errMax, 0, 'and prediction stayed in step');
  assert.equal(r.world.totals.inputsDropped, 0);
});

test('the clock: every player is told the hour, and it runs at 48 minutes to the day', () => {
  const r = rig({ hour: 23 });
  const s = r.join('Ada', 50, { sample: () => {} });
  r.run(2000); assert.ok(Math.abs(s.hour(r.clock.t) - (23 + 2 / 120)) < 0.01, `it is ${s.hour(r.clock.t).toFixed(3)}`);
  r.run(4 * 60 * 1000); assert.ok(Math.abs(s.hour(r.clock.t) - 1.0167) < 0.02, `two hours later it is ${s.hour(r.clock.t).toFixed(3)}, past midnight`);
  r.world.dayOffset += 6 * 2 * 60 * 1000; r.run(1500);           // the host moves the clock on six hours
  assert.ok(Math.abs(s.hour(r.clock.t) - 7.03) < 0.03, `and the player follows: ${s.hour(r.clock.t).toFixed(3)}`);
});
