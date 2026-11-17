// Unit tests for the code both sides share: the codec, the terrain, and the feel of movement on foot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader } from '../shared/net/codec.js';
import { qPos, dPos, qY, dY, qYaw, dYaw } from '../shared/net/messages.js';
import { seqDiff, TAU } from '../shared/math.js';
import { makeField } from '../shared/world/field.js';
import { makeFoot, stepFoot, FOOT, BTN } from '../shared/sim/moveFoot.js';
import { HUB_X, HUB_Z, SIM_DT } from '../shared/constants.js';

const field = makeField(1899);
const cmd = (mx, mz, yawRad, buttons = 0) => ({ mx, mz, yaw: Math.round((((yawRad % TAU) + TAU) % TAU) / TAU * 65536) & 65535, buttons });
// open ground well away from the test obstacles, still on the flat table
const open = () => makeFoot(HUB_X + 40, field.base, HUB_Z + 40);

test('codec round-trips every field type', () => {
  const w = new Writer(256);
  w.u8(200); w.i8(-100); w.u16(54321); w.u24(131071); w.u32(4000000000); w.f32(1.5); w.f64(Math.PI);
  w.varu(0); w.varu(127); w.varu(128); w.varu(300000); w.vari(0); w.vari(-1); w.vari(63); w.vari(-64); w.vari(-70000); w.str('Malachi'); w.str('');
  const r = new Reader(w.bytes());
  assert.equal(r.u8(), 200); assert.equal(r.i8(), -100); assert.equal(r.u16(), 54321); assert.equal(r.u24(), 131071);
  assert.equal(r.u32(), 4000000000); assert.equal(r.f32(), 1.5); assert.equal(r.f64(), Math.PI);
  assert.deepEqual([r.varu(), r.varu(), r.varu(), r.varu()], [0, 127, 128, 300000]);
  assert.deepEqual([r.vari(), r.vari(), r.vari(), r.vari(), r.vari()], [0, -1, 63, -64, -70000]);
  assert.equal(r.str(), 'Malachi'); assert.equal(r.str(), ''); assert.equal(r.left, 0);
});

test('a short message throws instead of reading past the end', () => {
  const r = new Reader(new Uint8Array([1, 2]));
  r.u16();
  assert.throws(() => r.u16(), RangeError);
});

test('small deltas take one byte, as the bandwidth budget assumes', () => {
  const w = new Writer(16);
  w.vari(21); w.vari(-21); w.vari(63); w.vari(-64);
  assert.equal(w.o, 4);
  w.reset(); w.vari(87);                       // a gallop between two 5 Hz updates
  assert.equal(w.o, 2);
});

test('quantisation stays inside its stated error', () => {
  for (const v of [0, 4.017, 2048.33, 4095.99]) assert.ok(Math.abs(dPos(qPos(v)) - v) <= 1 / 64 + 1e-9);
  for (const v of [-10, 0, 20.04, 900]) assert.ok(Math.abs(dY(qY(v)) - v) <= 1 / 32 + 1e-9);
  for (const a of [0, 1, 3.1, -2]) assert.ok(Math.abs(Math.sin(dYaw(qYaw(a)) - a)) <= Math.sin(TAU / 256));
  assert.ok(qPos(4096) < 2 ** 24 && qY(4000) < 2 ** 16);
});

test('sequence numbers compare across the 16-bit wrap', () => {
  assert.equal(seqDiff(5, 3), 2); assert.equal(seqDiff(2, 65534), 4); assert.equal(seqDiff(65534, 2), -4);
});

test('terrain is flat at the hub, rolling beyond it, and the same on every build', () => {
  const t = field.terrain;
  assert.equal(t.heightAt(HUB_X, HUB_Z), 20);
  assert.equal(t.heightAt(HUB_X + 50, HUB_Z - 30), 20);
  const far = [t.heightAt(300, 700), t.heightAt(3500, 900), t.heightAt(1000, 3000)];
  assert.ok(far.some(h => Math.abs(h - 20) > 1), 'hills exist away from the hub');
  // pinned values: if these change, old clients and new servers disagree about the ground
  assert.deepEqual(far.map(h => Math.round(h * 1000)), [9557, 25756, 33796]);
  const again = makeField(1899).terrain;
  for (const [x, z] of [[300, 700], [3500, 900], [1234.5, 2345.25]]) assert.equal(again.heightAt(x, z), t.heightAt(x, z));
  assert.notEqual(makeField(7).terrain.heightAt(300, 700), t.heightAt(300, 700));
});

test('feel: a standing start reaches a sprint in about 0.9 s', () => {
  const s = open(); let steps = 0;
  while (Math.hypot(s.vx, s.vz) < FOOT.sprint - 1e-6 && steps < 200) { stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), field); steps++; }
  const t = steps * SIM_DT;
  assert.ok(t > 0.8 && t < 0.95, `took ${t.toFixed(2)} s`);
});

test('feel: from a sprint it takes 0.4 s and about 1.3 m to stop', () => {
  const s = open();
  for (let i = 0; i < 120; i++) stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), field);
  const x0 = s.x, z0 = s.z; let steps = 0;
  while (Math.hypot(s.vx, s.vz) > 0 && steps < 200) { stepFoot(s, cmd(0, 0, 0), field); steps++; }
  const t = steps * SIM_DT, d = Math.hypot(s.x - x0, s.z - z0);
  assert.ok(t >= 0.38 && t <= 0.42, `took ${t.toFixed(2)} s`);
  assert.ok(d > 1.1 && d < 1.5, `slid ${d.toFixed(2)} m`);
});

test('feel: a sprint turns in an arc of about 2 m, not on the spot', () => {
  const s = open();
  for (let i = 0; i < 120; i++) stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), field);       // sprinting north
  const x0 = s.x; let steps = 0;
  // ask for east and time the quarter turn
  while (Math.abs(s.vz) > 0.05 * FOOT.sprint && steps < 200) { stepFoot(s, cmd(0, 127, -Math.PI / 2, BTN.SPRINT), field); steps++; }
  const t = steps * SIM_DT, radius = FOOT.sprint / ((Math.PI / 2) / t);
  assert.ok(radius > 1.6 && radius < 2.2, `radius ${radius.toFixed(2)} m`);
  assert.ok(s.x > x0, 'it turned east');
});

test('feel: throwing the stick the other way plants before it reverses', () => {
  const s = open();
  for (let i = 0; i < 120; i++) stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), field);       // north is -z
  const z0 = s.z; let minZ = s.z, steps = 0;
  while (s.vz <= 0 && steps < 200) { stepFoot(s, cmd(0, 127, Math.PI, BTN.SPRINT), field); steps++; if (s.z < minZ) minZ = s.z; }
  assert.ok(z0 - minZ > 0.5, 'it carried on north for a stride first');
  assert.ok(steps * SIM_DT > 0.2 && steps * SIM_DT < 0.6, `turned round in ${(steps * SIM_DT).toFixed(2)} s`);
});

test('the same inputs give the same result, to the last bit', () => {
  const run = () => {
    const s = makeFoot(HUB_X + 3, field.base, HUB_Z + 3);
    for (let i = 0; i < 1800; i++) stepFoot(s, cmd(((i * 37) % 255) - 127, ((i * 91) % 255) - 127, i * 0.013, (i % 97 === 0 ? BTN.JUMP : 0) | (i % 5 ? BTN.SPRINT : 0)), field);
    return s;
  };
  assert.deepEqual(run(), run());
});

test('solid things stop a body, steps can be climbed, and a jump comes back down', () => {
  // run west into the pen's back wall from inside
  const s = makeFoot(HUB_X - 24, field.base, HUB_Z + 20);
  for (let i = 0; i < 240; i++) stepFoot(s, cmd(0, 127, Math.PI / 2, BTN.SPRINT), field);
  assert.ok(s.x > HUB_X - 30 + FOOT.r - 0.01, `stopped at the wall (x = ${(s.x - HUB_X).toFixed(2)})`);
  // walk east up the steps onto the deck
  const c = makeFoot(HUB_X + 12, field.base, HUB_Z - 1);
  for (let i = 0; i < 220; i++) stepFoot(c, cmd(0, 127, -Math.PI / 2, 0), field);
  assert.ok(Math.abs(c.y - (field.base + 1.2)) < 1e-6, `on the deck (y = ${(c.y - field.base).toFixed(2)})`);
  // jump
  const j = open(); stepFoot(j, cmd(0, 0, 0, BTN.JUMP), field);
  assert.equal(j.ground, 0); let top = j.y, n = 0;
  while (!j.ground && n < 200) { stepFoot(j, cmd(0, 0, 0, BTN.JUMP), field); if (j.y > top) top = j.y; n++; }
  assert.ok(top - field.base > 0.4 && top - field.base < 0.6, `apex ${(top - field.base).toFixed(2)} m`);
  assert.equal(j.y, field.base);
  stepFoot(j, cmd(0, 0, 0, BTN.JUMP), field);
  assert.equal(j.ground, 1, 'holding jump does not bounce');
});
