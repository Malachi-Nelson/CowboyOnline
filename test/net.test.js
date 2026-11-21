// Small promises the netcode makes elsewhere: byte counts the protocol document quotes, the delay curve, and the
// simulated-lag wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader } from '../shared/net/codec.js';
import { encInputHead, encCmd, encHints, encPing, encPong, encWelcome, decWelcome, writeSnapshotHead, writeSelf, readSelf, writeSpawn, spawnSize, writeStatus, makeStatus, writeEvent, EV, EV_SIZE, SNAPSHOT_HEAD, SELF_SIZE, HORSE_SIZE, GUN_SIZE, STATUS_SIZE } from '../shared/net/messages.js';
import { BAND_NEAR, BAND_MID, BAND_FAR, TICK_MS, SNAPSHOT_BUDGET, TICK_RATE, KIND_HORSE, KIND_PLAYER } from '../shared/constants.js';
import { makeActor, stepActor, AF } from '../shared/sim/actor.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { flatField } from '../shared/world/field.js';
import { intervalFor, Remote } from '../client/src/net/interp.js';
import { LagTransport } from '../client/src/net/transport.js';

test('message sizes are what the protocol document says', () => {
  const w = new Writer(256), a = makeActor(1, 2, 3, true);
  encInputHead(w, 1, 3, 0); for (let i = 0; i < 3; i++) encCmd(w, 0, 127, 0, 0, 1); encHints(w, []);
  assert.equal(w.o, 31, 'three inputs in a packet');
  encInputHead(w, 1, 3, 0); for (let i = 0; i < 3; i++) encCmd(w, 0, 127, 0, 0, 1); encHints(w, [{ seq: 2, target: 9, ms: 1234 }]);
  assert.equal(w.o, 37, 'and with a hint for a shot');
  assert.equal(encPing(w, 1).length, 9); assert.equal(encPong(w, 1, 2, 3).length, 21);
  writeSnapshotHead(w, 1, 2, a, false); assert.equal(w.o, SNAPSHOT_HEAD); assert.equal(SNAPSHOT_HEAD, 33);
  writeSnapshotHead(w, 1, 2, a, true); assert.equal(w.o, SNAPSHOT_HEAD + HORSE_SIZE); assert.equal(SELF_SIZE + HORSE_SIZE, 66);
  writeSnapshotHead(w, 1, 2, a, true, true); assert.equal(w.o, SNAPSHOT_HEAD + HORSE_SIZE + GUN_SIZE); assert.equal(GUN_SIZE, 24);
  let at0 = w.o; writeStatus(w, makeStatus()); assert.equal(w.o - at0, STATUS_SIZE);
  for (const [type, ev] of [[EV.SHOT, { id: 1, gun: 1, yaw: 2, pitch: -3, dist: 12.3, struck: 1 }], [EV.HIT, { id: 1, by: 2, zone: 2, dmg: 34, yaw: 9, hp: 66 }], [EV.DIE, { id: 1, by: 2, zone: 1 }], [EV.NOTE, { code: 1, value: 2 }]]) {
    at0 = w.o; writeEvent(w, { type, ...ev }); assert.equal(w.o - at0, EV_SIZE[type], 'event ' + type);
  }
  const e = { id: 7, kind: KIND_PLAYER, ef: 0, name: 'Hattie', nameBytes: 6, qx: 1, qy: 2, qz: 3, qyaw: 4, st: 1, gear: 0 }; let at = w.o;
  writeSpawn(w, e); assert.equal(w.o - at, spawnSize(e)); assert.equal(spawnSize(e), 22);
  const h = { id: 8, kind: KIND_HORSE, ef: 0, name: '', nameBytes: 0, qx: 1, qy: 2, qz: 3, qyaw: 4, st: 1, gear: 0, owner: e }; at = w.o;
  writeSpawn(w, h); assert.equal(w.o - at, spawnSize(h)); assert.equal(spawnSize(h), 18);
  assert.ok((SNAPSHOT_BUDGET + 4) * TICK_RATE <= 16000, 'a full snapshot every tick stays inside 16 KB/s');
});

test('a player and their horse survive the trip over the wire exactly', () => {
  const f = flatField(), a = makeActor(2100, f.base, 2100, true), w = new Writer(256);
  a.h.x += 30; const cmd = { mx: 30, mz: 127, yaw: 9000, buttons: BTN.WHISTLE };
  for (let i = 0; i < 200; i++) { cmd.buttons = i === 0 ? BTN.WHISTLE : i === 150 ? BTN.USE : BTN.SPRINT; stepActor(a, cmd, f); }
  a.r1 = 7; a.m2 = 3; a.slot = 2; a.bloom = Math.fround(0.0125); a.focus = Math.fround(0.5); a.gfl = 5; a.jail = 1;
  w.reset(); writeSelf(w, a, true, true);
  const b = makeActor(0, 0, 0, false), fl = readSelf(new Reader(w.bytes()), b);
  assert.ok(fl & AF.HORSE_BLOCK); assert.ok(fl & AF.GUN_BLOCK); assert.deepEqual(b, a);
  // without the horse block, the horse the reader already has is left alone
  const keep = b.h.x; a.f.x += 1; w.reset(); writeSelf(w, a, false); readSelf(new Reader(w.bytes()), b);
  assert.equal(b.f.x, a.f.x); assert.equal(b.h.x, keep);
  // and the welcome carries all of it
  const o = decWelcome(new Reader(encWelcome(w, { id: 5, tickRate: 20, tick: 99, serverNow: 1234.5, dayMs: 777, seed: 1899, token: 'abc', horseId: 6, actor: a }).subarray(1)), b);
  assert.deepEqual([o.id, o.tick, o.serverNow, o.dayMs, o.seed, o.token, o.horseId], [5, 99, 1234.5, 777, 1899, 'abc', 6]); assert.deepEqual(b, a);
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
  run.reset(); run.push(2000, 50, 0, 0, 0, true); run.sample(1950); assert.equal(run.x, 50, 'after a reset it is simply where it was put');
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
