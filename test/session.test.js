// The client half, end to end against a real world: prediction, correction, and how other players are drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.js';
import { rng32 } from '../shared/math.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { HUB_X, HUB_Z, TICK_MS, ST_MOVE } from '../shared/constants.js';

const WEST = 16384, EAST = 49152, NORTH = 0;
// a player who wanders: turns, strafes, sprints, stops and jumps, the same way every run
const wander = seed => {
  const r = rng32(seed); let n = 0, yaw = r() * 65536, mx = 0, mz = 127, b = 0;
  return c => {
    if (n++ % 45 === 0) { yaw += (r() - 0.5) * 30000; mx = r() < 0.3 ? (r() < 0.5 ? -127 : 127) : 0; mz = r() < 0.15 ? 0 : r() < 0.1 ? -127 : 127; b = r() < 0.5 ? BTN.SPRINT : r() < 0.2 ? BTN.WALK : 0; }
    c.mx = mx; c.mz = mz; c.yaw = yaw; c.buttons = b | (r() < 0.01 ? BTN.JUMP : 0);
  };
};
const hold = (yaw, buttons = 0, mz = 127) => c => { c.mx = 0; c.mz = mz; c.yaw = yaw; c.buttons = buttons; };

test('prediction agrees with the server at 160 ms of ping with jitter, walls, steps and jumps included', () => {
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

test('when the server disagrees the player is put right, and the view glides there', () => {
  const r = rig();
  const s = r.join('Ada', 60, { sample: hold(WEST, BTN.SPRINT) });
  r.run(3000);
  const p = r.world.people[0];
  p.s.z += 1.5;                                                   // the server knows something the client did not predict
  let glided = false, jumped = 0, before = s.z;
  for (let i = 0; i < 60; i++) { r.run(16); const dz = Math.abs(s.z - before); if (dz > jumped) jumped = dz; before = s.z; if (s.stats.corrections && Math.abs(s.oz) > 0.2) glided = true; }
  assert.equal(s.stats.corrections, 1);
  assert.ok(glided, 'the correction was spread over several frames');
  assert.ok(jumped < 0.45, `largest single-frame shift ${jumped.toFixed(2)} m of a 1.5 m correction`);
  r.run(2000);
  // prediction is back in step with the server: nothing further to correct, and no offset left
  assert.equal(s.stats.corrections, 1);
  assert.ok(Math.abs(s.oz) < 1e-3);
  assert.ok(s.stats.errLast < 0.001);
});

test('another player is drawn where they really were, a tenth of a second ago', () => {
  const r = rig(), j1 = rng32(3), j2 = rng32(4);
  const a = r.join('Ada', () => 40 + j1() * 15, { sample: wander(21) });
  const b = r.join('Boone', () => 70 + j2() * 20, { sample: () => {} });       // stands and watches
  r.run(2000);
  const pa = r.world.people.find(p => p.name === 'Ada'), truth = [];
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

test('someone far off who has been standing still does not drift before they set off', () => {
  const r = rig();
  let go = false;
  const a = r.join('Ada', 30, { sample: c => { c.mx = 0; c.mz = go ? 127 : 0; c.yaw = EAST; c.buttons = BTN.SPRINT; } });
  const b = r.join('Boone', 30, { sample: () => {} });
  r.run(500);
  const pa = r.world.people.find(p => p.name === 'Ada'), pb = r.world.people.find(p => p.name === 'Boone');
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
  b.onspawn = e => seen.push('met ' + e.name); b.ondespawn = e => seen.push('lost ' + e.name);
  r.run(600);
  const pa = r.world.people.find(p => p.name === 'Ada'), x = pa.s.x;
  pa.s.x = x + 600; r.run(600); assert.equal(b.ents.size, 0);
  pa.s.x = x; r.run(600); assert.equal(b.ents.size, 1);
  assert.deepEqual(seen, ['met Ada', 'lost Ada', 'met Ada']);
  assert.equal(b.stats.unknown, 0);
});

test('input numbers wrap at 65,536 without a hiccup', () => {
  const r = rig();
  const s = r.join('Ada', 0, { sample: wander(31) });
  r.run(1300); r.flush();
  // jump to just short of the wrap, on both sides, as if 18 minutes had passed
  const p = r.world.people[0];
  const shift = (65400 - s.seq) & 65535;
  s.seq = (s.seq + shift) & 65535; s.ack = (s.ack + shift) & 65535; p.ackSeq = (p.ackSeq + shift) & 65535; p.lastQueued = (p.lastQueued + shift) & 65535;
  for (let i = 0; i < p.q.length; i++) p.q[i].seq = (p.q[i].seq + shift) & 65535;
  for (const k of ['cMx', 'cMz', 'cYaw', 'cBtn', 'pX', 'pY', 'pZ', 'pVx', 'pVy', 'pVz', 'pFl']) { const src = s[k].slice(), n = src.length; for (let i = 0; i < n; i++) s[k][(i + shift) & (n - 1)] = src[i]; }
  r.run(8000);
  assert.ok(s.seq < 1000, `wrapped (now at ${s.seq})`);
  assert.equal(s.stats.corrections, 0, 'no correction on the way through');
  assert.equal(s.stats.errMax, 0, 'and prediction stayed in step');
  assert.equal(r.world.totals.inputsDropped, 0);
});
