// Small promises the netcode makes elsewhere: byte counts the protocol document quotes, the delay curve, and the
// simulated-lag wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer } from '../shared/net/codec.js';
import { encInputHead, encCmd, encPing, encPong, writeSnapshotHead, writeSpawn, spawnSize, SNAPSHOT_HEAD } from '../shared/net/messages.js';
import { BAND_NEAR, BAND_MID, BAND_FAR, TICK_MS, SNAPSHOT_BUDGET, TICK_RATE } from '../shared/constants.js';
import { makeFoot } from '../shared/sim/moveFoot.js';
import { intervalFor, Remote } from '../client/src/net/interp.js';
import { LagTransport } from '../client/src/net/transport.js';

test('message sizes are what the protocol document says', () => {
  const w = new Writer(256);
  encInputHead(w, 1, 3, 0); for (let i = 0; i < 3; i++) encCmd(w, 0, 127, 0, 1);
  assert.equal(w.o, 21, 'three inputs in a packet');
  assert.equal(encPing(w, 1).length, 9); assert.equal(encPong(w, 1, 2).length, 17);
  writeSnapshotHead(w, 1, 2, makeFoot(1, 2, 3), 1); assert.equal(w.o, SNAPSHOT_HEAD);
  const e = { id: 7, kind: 1, ef: 0, name: 'Hattie', nameBytes: 6, qx: 1, qy: 2, qz: 3, qyaw: 4, st: 1 }, at = w.o;
  writeSpawn(w, e); assert.equal(w.o - at, spawnSize(e));
  assert.ok((SNAPSHOT_BUDGET + 4) * TICK_RATE <= 16000, 'a full snapshot every tick stays inside 16 KB/s');
});

test('others are never drawn closer to the present than the server refreshes them', () => {
  const serverEvery = d => (d < BAND_NEAR ? 1 : d < BAND_MID ? 2 : d < BAND_FAR ? 4 : 10) * TICK_MS;
  let prev = intervalFor(0);
  for (let d = 0; d <= 460; d += 0.25) {
    const v = intervalFor(d);
    assert.ok(v >= serverEvery(d), `at ${d} m the delay covers the update interval`);
    assert.ok(v >= prev && v - prev < 6, `no jump at ${d} m`);            // rises smoothly, so nothing skips back in time
    prev = v;
  }
});

test('a late update carries a moving body forward a little, and leaves a standing one alone', () => {
  const run = new Remote(1, 1, 0, 'a'); run.push(1000, 0, 0, 0, 0, true); run.push(1050, 0.3, 0, 0, 0, true);
  run.sample(1100); assert.ok(Math.abs(run.x - 0.6) < 1e-6, 'carried on at the same speed');
  run.sample(1400); assert.ok(Math.abs(run.x - 0.9) < 1e-6, 'but only for a tenth of a second');
  const still = new Remote(2, 1, 0, 'b'); still.push(1000, 0, 0, 0, 0, true); still.push(1050, 0.3, 0, 0, 0, false);
  still.sample(1400); assert.equal(still.x, Math.fround(0.3));
  run.sample(1025); assert.ok(Math.abs(run.x - 0.15) < 1e-6, 'and between two samples it is in between');
});

test('simulated lag delays messages both ways and keeps them in order', async () => {
  const got = [], sent = [];
  const inner = { open() { this.onopen(); }, send: b => sent.push([b[0], performance.now()]), close() {} };
  let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lag = new LagTransport(inner, 20, 30, rand);
  lag.onmessage = b => got.push([b[0], performance.now()]);
  lag.open();
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) { lag.send(new Uint8Array([i])); inner.onmessage(new Uint8Array([i])); await new Promise(r => setTimeout(r, 2)); }
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(sent.map(m => m[0]), [...Array(40).keys()]); assert.deepEqual(got.map(m => m[0]), [...Array(40).keys()]);
  assert.ok(sent[0][1] - t0 >= 19 && got[0][1] - t0 >= 19, 'nothing arrives early');
  lag.close();
});
