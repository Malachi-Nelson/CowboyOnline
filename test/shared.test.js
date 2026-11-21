// Unit tests for the code both sides share: the codec, the territory, and how moving on foot and on horseback feels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader } from '../shared/net/codec.js';
import { qPos, dPos, qY, dY, qYaw, dYaw } from '../shared/net/messages.js';
import { seqDiff, TAU } from '../shared/math.js';
import { makeField, flatField } from '../shared/world/field.js';
import { SWAMP_LEVEL } from '../shared/world/terrain.js';
import { TREE_N } from '../shared/world/trees.js';
import { makeFoot, stepFoot, FOOT, BTN } from '../shared/sim/moveFoot.js';
import { HORSE, HMODE } from '../shared/sim/moveHorse.js';
import { makeActor, stepActor } from '../shared/sim/actor.js';
import { SIN16, COS16, sinSmall, cosSmall } from '../shared/sim/trig.js';
import { HUB_X, HUB_Z, SIM_DT } from '../shared/constants.js';

const flat = flatField(), land = makeField();
const cmd = (mx, mz, yawRad, buttons = 0) => ({ mx, mz, yaw: Math.round((((yawRad % TAU) + TAU) % TAU) / TAU * 65536) & 65535, buttons });
// open level ground, well away from the obstacles
const open = () => makeFoot(HUB_X + 40, flat.base, HUB_Z + 40);
const mounted = (f = flat, x = HUB_X + 60, z = HUB_Z + 60) => { const a = makeActor(x, f.terrain.heightAt(x, z), z, true); a.riding = 1; return a; };
const NORTH = 0, WEST = Math.PI / 2, EAST = -Math.PI / 2;

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

test('the arithmetic-only sine and cosine match the real ones', () => {
  let worst = 0;
  for (let i = 0; i < 65536; i++) { const a = i / 65536 * TAU; worst = Math.max(worst, Math.abs(SIN16[i] - Math.sin(a)), Math.abs(COS16[i] - Math.cos(a))); }
  assert.ok(worst < 6e-8, `table off by at most ${worst}`);                         // 32-bit rounding and nothing more
  assert.equal(SIN16[0], 0); assert.equal(COS16[0], 1); assert.equal(SIN16[16384], 1); assert.equal(COS16[32768], -1);
  for (const a of [0, 0.01, 0.0583, 0.2, 0.25]) { assert.ok(Math.abs(sinSmall(a) - Math.sin(a)) < 1e-10); assert.ok(Math.abs(cosSmall(a) - Math.cos(a)) < 1e-10); }
});

// ---- the territory
test('the territory: a level town on a river, mountains, a swamp at water level, and the same on every build', () => {
  const t = land.terrain;
  assert.equal(t.heightAt(HUB_X, HUB_Z), land.base, 'the hub stands on its pad');
  assert.ok(Math.abs(t.heightAt(HUB_X - 120, HUB_Z + 60) - land.base) < 1e-3, 'and the pad is level a long way out');
  let hi = 0; for (let i = 0; i < t.H.length; i += 7) if (t.H[i] > hi) hi = t.H[i];
  assert.ok(hi > 300, `the Sawbacks stand ${hi.toFixed(0)} m high`);
  // the river: water at the bridge, about two metres below the town, deep in the middle
  const r = t.river, x = r.x[r.iHub];
  assert.ok(Math.abs(t.levelAt(x, HUB_Z) - (land.base - 2.2)) < 0.05);
  assert.ok(t.levelAt(x, HUB_Z) - t.heightAt(x, HUB_Z) > 2, 'deep in the channel');
  assert.ok(t.levelAt(HUB_X, HUB_Z) < t.heightAt(HUB_X, HUB_Z) - 2, 'the main street is well above the river');
  assert.ok(t.levelAt(1500, 2600) < -50, 'and out on the plains there is no water at all');
  for (let i = 1; i < r.n; i++) assert.ok(r.wl[i] <= r.wl[i - 1], 'the river never runs uphill');
  assert.equal(r.wl[r.n - 1], SWAMP_LEVEL);
  // nowhere beside the river is the land lower than the water in it (no leaks)
  let leaks = 0; for (let i = 0; i < t.H.length; i++) if (t.wet[i] > 0 && t.wet[i] < 250 && t.maskAt((i % 1025) * 4, ((i / 1025) | 0) * 4, 4) < 0.02 && t.W[i] > t.H[i]) leaks++;
  assert.equal(leaks, 0);
  // the Mirewood: standing water and dry hummocks, both
  let wet = 0, dry = 0; for (let z = 3200; z < 3700; z += 20) for (let x = 3200; x < 3700; x += 20) (t.levelAt(x, z) > t.heightAt(x, z) ? wet++ : dry++);
  assert.ok(wet > 150 && dry > 100, `${wet} wet, ${dry} dry`);
  // pinned values: if these change, old clients and new servers disagree about the ground
  assert.deepEqual([[300, 700], [3500, 900], [1000, 3000], [2150, 2048]].map(([x, z]) => Math.round(t.heightAt(x, z) * 1000)), PINNED);
  assert.ok(makeField() === land, 'built once and kept');
});
const PINNED = [165625, 47727, 60923, 31383];

test('the forest is the same everywhere too, and stays out of the streets, the roads and the river', () => {
  const tr = land.trees; let n = 0, sum = 0;
  for (let i = 0; i < tr.T.length; i++) if (tr.T[i]) { n++; sum = (sum + tr.T[i] * (i % 9973)) % 1000003; }
  assert.ok(n > 40000 && n < 90000, `${n} trees`);
  assert.equal(sum, TREE_SUM, 'pinned: the same trees in the same places');
  const at = (x, z) => tr.T[Math.floor(z / 8) * TREE_N + Math.floor(x / 8)];
  for (let x = 1890; x < 2100; x += 8) assert.equal(at(x, HUB_Z), 0);
  const rd = land.terrain.roads[1]; for (let i = 0; i < rd.n; i += 5) assert.equal(at(rd.x[i], rd.z[i]), 0);
  // a trunk stops a body
  let cx = 0, cz = 0; outer: for (cz = 150; cz < 200; cz++) for (cx = 100; cx < 160; cx++) if (tr.T[cz * TREE_N + cx]) break outer;
  const tx = tr.posX(cx, cz), tz = tr.posZ(cx, cz);
  assert.equal(tr.pushOut(tx + 0.2, tz, 0.34), 1); assert.ok(Math.hypot(tr.x - tx, tr.z - tz) > 0.34 + 0.15);
  assert.equal(tr.pushOut(tx + 3, tz + 3, 0.34), 0);
});
const TREE_SUM = 606292;

test('no building stands on another, and the bridge reaches both banks', () => {
  const bs = land.buildings; assert.ok(bs.length > 60);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i], b = bs[j]; assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1), `${a.sign || a.kind} and ${b.sign || b.kind} overlap`); }
  const br = land.bridge, t = land.terrain;
  assert.ok(Math.abs(t.heightAt(br.x0 - 1, HUB_Z) - land.base) < 0.05 && Math.abs(t.heightAt(br.x1 + 1, HUB_Z) - land.base) < 0.05, 'dry land at both ends');
  // walk it: from the main street to the far bank without getting wet
  const s = makeFoot(br.x0 - 6, land.base, HUB_Z); let low = 1e9;
  for (let i = 0; i < 60 * 30 && s.x < br.x1 + 4; i++) { stepFoot(s, cmd(0, 127, EAST, BTN.SPRINT), land); if (s.y < low) low = s.y; }
  assert.ok(s.x >= br.x1 + 4, `crossed (reached x = ${s.x.toFixed(1)})`);
  assert.ok(low > land.base - 0.01, 'on the deck all the way');
});

// ---- on foot
test('feel: a standing start reaches a sprint in about 0.9 s', () => {
  const s = open(); let steps = 0;
  while (Math.hypot(s.vx, s.vz) < FOOT.sprint - 1e-6 && steps < 200) { stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), flat); steps++; }
  const t = steps * SIM_DT;
  assert.ok(t > 0.8 && t < 0.95, `took ${t.toFixed(2)} s`);
});

test('feel: from a sprint it takes 0.4 s and about 1.3 m to stop', () => {
  const s = open();
  for (let i = 0; i < 120; i++) stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), flat);
  const x0 = s.x, z0 = s.z; let steps = 0;
  while (Math.hypot(s.vx, s.vz) > 0 && steps < 200) { stepFoot(s, cmd(0, 0, 0), flat); steps++; }
  const t = steps * SIM_DT, d = Math.hypot(s.x - x0, s.z - z0);
  assert.ok(t >= 0.38 && t <= 0.42, `took ${t.toFixed(2)} s`);
  assert.ok(d > 1.1 && d < 1.5, `slid ${d.toFixed(2)} m`);
});

test('feel: a sprint turns in an arc of about 2 m, not on the spot', () => {
  const s = open();
  for (let i = 0; i < 120; i++) stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), flat);       // sprinting north
  const x0 = s.x; let steps = 0;
  // ask for east and time the quarter turn
  while (Math.abs(s.vz) > 0.05 * FOOT.sprint && steps < 200) { stepFoot(s, cmd(0, 127, EAST, BTN.SPRINT), flat); steps++; }
  const t = steps * SIM_DT, radius = FOOT.sprint / ((Math.PI / 2) / t);
  assert.ok(radius > 1.6 && radius < 2.2, `radius ${radius.toFixed(2)} m`);
  assert.ok(s.x > x0, 'it turned east');
});

test('feel: throwing the stick the other way plants before it reverses', () => {
  const s = open();
  for (let i = 0; i < 120; i++) stepFoot(s, cmd(0, 127, 0, BTN.SPRINT), flat);       // north is -z
  const z0 = s.z; let minZ = s.z, steps = 0;
  while (s.vz <= 0 && steps < 200) { stepFoot(s, cmd(0, 127, Math.PI, BTN.SPRINT), flat); steps++; if (s.z < minZ) minZ = s.z; }
  assert.ok(z0 - minZ > 0.5, 'it carried on north for a stride first');
  assert.ok(steps * SIM_DT > 0.2 && steps * SIM_DT < 0.6, `turned round in ${(steps * SIM_DT).toFixed(2)} s`);
});

test('solid things stop a body, steps can be climbed, and a jump comes back down', () => {
  // run west into the pen's back wall from inside
  const s = makeFoot(HUB_X - 24, flat.base, HUB_Z + 20);
  for (let i = 0; i < 240; i++) stepFoot(s, cmd(0, 127, WEST, BTN.SPRINT), flat);
  assert.ok(s.x > HUB_X - 30 + FOOT.r - 0.01, `stopped at the wall (x = ${(s.x - HUB_X).toFixed(2)})`);
  // walk east up the steps onto the deck
  const c = makeFoot(HUB_X + 12, flat.base, HUB_Z - 1);
  for (let i = 0; i < 220; i++) stepFoot(c, cmd(0, 127, EAST, 0), flat);
  assert.ok(Math.abs(c.y - (flat.base + 1.2)) < 1e-6, `on the deck (y = ${(c.y - flat.base).toFixed(2)})`);
  // jump
  const j = open(); stepFoot(j, cmd(0, 0, 0, BTN.JUMP), flat);
  assert.equal(j.ground, 0); let top = j.y, n = 0;
  while (!j.ground && n < 200) { stepFoot(j, cmd(0, 0, 0, BTN.JUMP), flat); if (j.y > top) top = j.y; n++; }
  assert.ok(top - flat.base > 0.4 && top - flat.base < 0.6, `apex ${(top - flat.base).toFixed(2)} m`);
  assert.equal(j.y, flat.base);
  stepFoot(j, cmd(0, 0, 0, BTN.JUMP), flat);
  assert.equal(j.ground, 1, 'holding jump does not bounce');
});

test('water: wading slows a body, deep water floats it, and it swims slowly', () => {
  const t = land.terrain, r = t.river, x = r.x[r.iHub], z = HUB_Z - 60;
  // from the west bank straight into the river
  const s = makeFoot(x - 45, t.heightAt(x - 45, z), z); let wade = 0, swam = 0;
  for (let i = 0; i < 60 * 60 && s.x < x + 45; i++) {
    stepFoot(s, cmd(0, 127, EAST, BTN.SPRINT), land);
    const d = t.levelAt(s.x, s.z) - s.y, sp = Math.hypot(s.vx, s.vz);
    if (d > 0.8 && d < 1.15 && sp > wade) wade = sp;
    if (t.levelAt(s.x, s.z) - t.heightAt(s.x, s.z) > FOOT.swimAt + 0.05) { swam++; assert.ok(Math.abs(d - FOOT.swimAt) < 0.02, 'afloat, chest deep'); if (swam > 30) assert.ok(sp <= FOOT.swim + 1e-6, 'swimming pace'); }
  }
  assert.ok(s.x >= x + 45, 'reached the far bank');
  assert.ok(wade > 2 && wade < 5, `waded at ${wade.toFixed(1)} m/s`);
  assert.ok(swam > 300, `swam for ${(swam / 60).toFixed(1)} s`);
  stepFoot(s, cmd(0, 0, 0, BTN.JUMP), land); assert.equal(s.ground, 0, 'and can jump again on the bank');
});

test('slopes: a body goes up a hill slower, and not up a cliff at all', () => {
  const t = land.terrain;
  // find a face steeper than 50 degrees in the mountains and walk at it from below
  let fx = 0, fz = 0, gx = 0, gz = 0;
  search: for (fz = 300; fz < 1800; fz += 6) for (fx = 300; fx < 1500; fx += 6) { gx = t.heightAt(fx + 0.5, fz) - t.heightAt(fx - 0.5, fz); gz = t.heightAt(fx, fz + 0.5) - t.heightAt(fx, fz - 0.5); if (gx * gx + gz * gz > 1.7) break search; }
  const g = Math.hypot(gx, gz); assert.ok(g > 1.3, 'found a cliff');
  const s = makeFoot(fx, t.heightAt(fx, fz), fz), y0 = s.y, uphill = Math.atan2(-gx, -gz);       // yaw whose forward is up the slope
  for (let i = 0; i < 300; i++) stepFoot(s, cmd(0, 127, uphill, BTN.SPRINT), land);
  assert.ok(s.y - y0 < 1.5, `climbed only ${(s.y - y0).toFixed(2)} m in five seconds of trying`);
  for (let i = 0; i < 300; i++) stepFoot(s, cmd(0, 127, uphill, BTN.SPRINT | (i % 30 === 0 ? BTN.JUMP : 0)), land);
  assert.ok(s.y - y0 < 3, `and jumping did not help much (${(s.y - y0).toFixed(2)} m)`);
});

// ---- on horseback
test('feel: a horse takes about 4 s to reach a gallop of 17 m/s, and 2.5 s and 21 m to rein in', () => {
  const a = mounted(), h = a.h; let n = 0;
  while (h.sp < HORSE.gallop - 1e-3 && n < 1000) { stepActor(a, cmd(0, 127, NORTH, BTN.SPRINT), flat); n++; }
  assert.equal(HORSE.gallop, 17);
  assert.ok(n * SIM_DT > 4 && n * SIM_DT < 4.5, `to a gallop in ${(n * SIM_DT).toFixed(2)} s`);
  const z0 = h.z; n = 0;
  while (h.sp > 0 && n < 1000) { stepActor(a, cmd(0, -127, NORTH), flat); n++; }
  const stop = Math.abs(z0 - h.z);
  assert.ok(n * SIM_DT > 2.4 && n * SIM_DT < 2.6, `stopped in ${(n * SIM_DT).toFixed(2)} s`);
  assert.ok(stop > 20 && stop < 22.5, `in ${stop.toFixed(1)} m`);
  for (let i = 0; i < 90; i++) stepActor(a, cmd(0, -127, NORTH), flat);
  assert.ok(h.sp < -1 && h.z > z0 - stop - 1, 'held back, it backs up');
  assert.equal(a.f.x, h.x); assert.equal(a.f.z, h.z);            // the rider goes where the horse goes
});

test('feel: a horse turns in 2 m at a walk, 9 m at a canter and 21 m at a gallop', () => {
  for (const [name, btn, push, want] of [['walk', BTN.WALK, 52, 2], ['trot', BTN.WALK, 127, 4.4], ['canter', 0, 127, 8.8], ['gallop', BTN.SPRINT, 127, 21]]) {
    const a = mounted(), h = a.h;
    for (let i = 0; i < 400; i++) stepActor(a, cmd(0, push, NORTH, btn), flat);
    const sp = h.sp; let n = 0;
    while (h.hx > -0.999 && n < 2000) { stepActor(a, cmd(0, push, WEST, btn), flat); n++; }
    const radius = sp / ((Math.PI / 2) / (n * SIM_DT));
    assert.ok(Math.abs(radius - want) < want * 0.2, `${name}: ${sp.toFixed(1)} m/s, radius ${radius.toFixed(1)} m`);
  }
});

// ---- jumping
const jumpFrom = (btn, push, side = 0) => {
  const a = mounted(), h = a.h;
  for (let i = 0; i < 400; i++) stepActor(a, cmd(0, push, NORTH, btn), flat);
  const r = { y0: h.y, z0: h.z, sp0: h.sp, stam0: h.stam, hx: h.hx, hz: h.hz, top: 0, steps: 0, turned: 0 };
  stepActor(a, cmd(side, push, NORTH, btn | BTN.JUMP), flat); r.steps++;
  while (!h.ground && r.steps < 300) {
    stepActor(a, cmd(side, push, NORTH, btn | BTN.JUMP), flat); r.steps++;     // the key still held, and the stick hard over
    r.top = Math.max(r.top, h.y - r.y0); if (!h.ground && (h.hx !== r.hx || h.hz !== r.hz)) r.turned++;
  }
  r.len = r.z0 - h.z; r.after = h.sp; r.cost = r.stam0 - h.stam; r.a = a;
  return r;
};

test('jump: about 1.2 m and 6 m from a canter, 12 m from a gallop; only a hop from a walk', () => {
  const canter = jumpFrom(0, 127), gallop = jumpFrom(BTN.SPRINT, 127), walk = jumpFrom(BTN.WALK, 52), trot = jumpFrom(BTN.WALK, 127);
  assert.ok(canter.top > 1.1 && canter.top < 1.3, `canter: ${canter.top.toFixed(2)} m high`);
  assert.ok(canter.len > 5 && canter.len < 7, `canter: ${canter.len.toFixed(1)} m long`);
  assert.ok(gallop.top > 1.1 && gallop.top < 1.3 && gallop.len > 10.5 && gallop.len < 13, `gallop: ${gallop.top.toFixed(2)} m high, ${gallop.len.toFixed(1)} m long`);
  assert.ok(walk.top > 0.3 && walk.top < 0.6, `walk: a ${walk.top.toFixed(2)} m hop`);
  assert.ok(trot.top > walk.top && trot.top < canter.top, 'a trot is between the two');
  for (const r of [canter, gallop, walk]) {
    assert.equal(r.turned, 0, 'no steering in the air');
    assert.ok(r.after < r.sp0 && r.after > r.sp0 * 0.9, 'and it lands a little slower');
  }
  assert.ok(gallop.cost > HORSE.jumpCost * 0.9, `and it costs wind (${gallop.cost.toFixed(3)})`);
});

test('jump: holding the key jumps once; another press jumps again', () => {
  const r = jumpFrom(0, 127), a = r.a, h = a.h;
  for (let i = 0; i < 60; i++) { stepActor(a, cmd(0, 127, NORTH, BTN.JUMP), flat); assert.equal(h.ground, 1, 'held: no second jump'); }
  stepActor(a, cmd(0, 127, NORTH, 0), flat); stepActor(a, cmd(0, 127, NORTH, BTN.JUMP), flat);
  assert.equal(h.ground, 0, 'pressed again: up it goes');
});

test('jump: clears the 1.4 m wall of the pen if taken in the right place; without a jump the wall stops it', () => {
  const at = (btn, takeoff) => {
    const a = mounted(flat, HUB_X + 40, HUB_Z + 20), h = a.h; h.hx = -1; h.hz = 0; let done = false;
    for (let i = 0; i < 900 && h.x > HUB_X - 34; i++) {
      const j = takeoff !== null && !done && h.x - (HUB_X - 30) <= takeoff + HORSE.len + HORSE.r; if (j) done = true;
      stepActor(a, cmd(0, 127, WEST, btn | (j ? BTN.JUMP : 0)), flat);
    }
    return h.x - HUB_X;
  };
  assert.ok(at(BTN.SPRINT, 3) < -31, 'galloping: over');
  assert.ok(at(0, 1.5) < -31, 'cantering: over');
  assert.ok(at(BTN.SPRINT, null) > -30 + HORSE.r, 'not jumping: stopped');
  assert.ok(at(BTN.SPRINT, 12) > -30 + HORSE.r, 'jumping far too early: down in front of it, and stopped');
});

test('jump: not standing still, not swimming, not winded, and not up a cliff', () => {
  const a = mounted(), h = a.h;
  stepActor(a, cmd(0, 0, NORTH, BTN.JUMP), flat); assert.equal(h.ground, 1, 'standing: no');
  for (let i = 0; i < 120; i++) stepActor(a, cmd(0, 127, NORTH, 0), flat);
  h.winded = 1; stepActor(a, cmd(0, 127, NORTH, BTN.JUMP), flat); assert.equal(h.ground, 1, 'winded: no');
  // swimming the river
  const t = land.terrain, r = t.river, x = r.x[r.iHub], z = HUB_Z - 60, b = mounted(land, x - 45, z), hb = b.h; let tried = 0;
  for (let i = 0; i < 60 * 60 && hb.x < x + 45; i++) {
    const deep = t.levelAt(hb.x, hb.z) - hb.y > 1.4, j = deep && i % 2 === 0;
    stepActor(b, cmd(0, 127, EAST, j ? BTN.JUMP : 0), land);
    if (j) { tried++; assert.ok(hb.ground && hb.vy === 0, 'swimming: no'); }
  }
  assert.ok(tried > 50);
  // on ground a little too steep to climb (40 to 45 degrees), jumping at it again and again
  let worst = 0, spots = 0;
  for (let fz = 300; fz < 1800 && spots < 12; fz += 23) for (let fx = 300; fx < 1500 && spots < 12; fx += 29) {
    const gx = t.heightAt(fx + 0.5, fz) - t.heightAt(fx - 0.5, fz), gz = t.heightAt(fx, fz + 0.5) - t.heightAt(fx, fz - 0.5), g = Math.hypot(gx, gz);
    if (g < 0.8 || g > 1) continue; spots++;
    const c = mounted(land, fx, fz), y0 = c.h.y, uphill = Math.atan2(-gx, -gz);
    for (let i = 0; i < 600; i++) stepActor(c, cmd(0, 127, uphill, BTN.SPRINT | (i % 20 === 0 ? BTN.JUMP : 0)), land);
    worst = Math.max(worst, c.h.y - y0);
  }
  assert.ok(spots >= 8, 'found the slopes');
  assert.ok(worst < 1, `climbed at most ${worst.toFixed(2)} m in ten seconds of jumping at a slope too steep to climb`);
});

test('feel: a gallop lasts about half a minute, then the horse must get its wind back', () => {
  const a = mounted(), h = a.h; let n = 0;
  while (!h.winded && n < 5000) { stepActor(a, cmd(0, 127, NORTH, BTN.SPRINT), flat); n++; }
  assert.ok(n * SIM_DT > 30 && n * SIM_DT < 36, `galloped for ${(n * SIM_DT).toFixed(1)} s`);
  for (let i = 0; i < 180; i++) stepActor(a, cmd(0, 127, NORTH, BTN.SPRINT), flat);
  assert.ok(h.sp <= HORSE.canter + 0.01, 'winded: a canter is all it has');
  n = 0; while (h.winded && n < 5000) { stepActor(a, cmd(0, 127, NORTH, BTN.SPRINT), flat); n++; }
  assert.ok(n * SIM_DT > 2 && n * SIM_DT < 8, `breath back in ${(n * SIM_DT + 3).toFixed(1)} s`);
  for (let i = 0; i < 240; i++) stepActor(a, cmd(0, 127, NORTH, BTN.SPRINT), flat);
  assert.ok(h.sp > HORSE.canter + 1, 'and then it will gallop again');
});

test('a horse will not go up a cliff, swims a river, and a wall stops it', () => {
  const t = land.terrain, r = t.river, x = r.x[r.iHub], z = HUB_Z - 60;
  const a = mounted(land, x - 45, z), h = a.h; let swam = 0;
  for (let i = 0; i < 60 * 60 && h.x < x + 45; i++) { stepActor(a, cmd(0, 127, EAST), land); if (t.levelAt(h.x, h.z) - h.y > 1.4) { if (++swam > 45) assert.ok(h.sp <= HORSE.swim + 1e-4, 'swimming pace'); } }
  assert.ok(h.x >= x + 45 && swam > 200, `swam the river in ${(swam / 60).toFixed(1)} s`);
  // into the wall of the pen on the flat field
  const b = mounted(flat, HUB_X - 24, HUB_Z + 20);
  for (let i = 0; i < 600; i++) stepActor(b, cmd(0, 127, WEST, BTN.SPRINT), flat);
  assert.ok(b.h.x > HUB_X - 30 + HORSE.r, `stopped short of the wall (x = ${(b.h.x - HUB_X).toFixed(2)})`);
});

// ---- the whistle, and getting on and off
test('whistle: a horse 40 m off runs to its owner and stands beside them; E mounts, E again steps down', () => {
  const a = makeActor(HUB_X + 60, flat.base, HUB_Z + 60, true), h = a.h; h.x += 40;
  stepActor(a, cmd(0, 0, 0, BTN.USE), flat); assert.equal(a.riding, 0, 'too far to mount');
  stepActor(a, cmd(0, 0, 0, 0), flat);
  stepActor(a, cmd(0, 0, 0, BTN.WHISTLE), flat); assert.equal(h.mode, HMODE.COME);
  let n = 0, top = 0; while (h.mode && n < 4000) { stepActor(a, cmd(0, 0, 0, BTN.WHISTLE), flat); n++; if (h.sp > top) top = h.sp; }
  for (let i = 0; i < 90; i++) stepActor(a, cmd(0, 0, 0, 0), flat);
  const d = Math.hypot(h.x - a.f.x, h.z - a.f.z);
  assert.ok(n * SIM_DT < 9, `arrived in ${(n * SIM_DT).toFixed(1)} s`); assert.ok(top > 9, 'at a run');
  assert.ok(d > 1 && d < HORSE.reach && h.sp === 0, `and stands ${d.toFixed(2)} m away`);
  stepActor(a, cmd(0, 0, 0, BTN.USE), flat); assert.equal(a.riding, 1);
  stepActor(a, cmd(0, 127, 0, BTN.USE), flat); assert.equal(a.riding, 1, 'holding the key does not throw the rider straight off');
  for (let i = 0; i < 120; i++) stepActor(a, cmd(0, 127, 0, 0), flat);
  assert.ok(h.sp > 5 && a.f.z === h.z, 'riding');
  stepActor(a, cmd(0, 127, 0, BTN.USE), flat); assert.equal(a.riding, 0);
  assert.ok(Math.abs(Math.hypot(a.f.x - h.x, a.f.z - h.z) - 1.15) < 0.2, 'down on the near side');
  for (let i = 0; i < 300; i++) stepActor(a, cmd(0, 0, 0, 0), flat);
  assert.equal(h.sp, 0, 'and the horse comes to rest by itself');
});

test('stepping down on the bridge leaves the rider on the deck, whichever edge the horse is near', () => {
  const b = land.bridge, x = (b.x0 + b.x1) / 2;
  for (const [z, hx] of [[b.z0 + 0.62, 1], [b.z1 - 0.62, 1], [b.z0 + 0.62, -1], [b.z1 - 0.62, -1]]) {      // alongside the rail
    const a = makeActor(x, b.y, z, true); a.riding = 1; a.h.hx = hx; a.h.hz = 0;
    stepActor(a, cmd(0, 0, 0, 0), land); stepActor(a, cmd(0, 0, 0, BTN.USE), land); assert.equal(a.riding, 0);
    for (let i = 0; i < 60; i++) stepActor(a, cmd(0, 0, 0, 0), land);
    assert.ok(Math.abs(a.f.y - b.y) < 0.3 && a.f.z > b.z0 && a.f.z < b.z1, `on the deck (${(a.f.y - b.y).toFixed(2)} m, z ${(a.f.z - b.z0).toFixed(2)} m from the north edge)`);
  }
});

test('whistle: from too far to run it is brought in behind the view, with a clear run to its owner', () => {
  // the owner on the main street, the horse on the far side of the river
  const a = makeActor(HUB_X, land.base, HUB_Z, true), h = a.h, t = land.terrain;
  h.x = 2600; h.z = 2300; h.y = t.heightAt(h.x, h.z);
  stepActor(a, cmd(0, 0, NORTH, BTN.WHISTLE), land);
  const d0 = Math.hypot(h.x - a.f.x, h.z - a.f.z);
  assert.ok(d0 > 40 && d0 < 60, `brought in to ${d0.toFixed(0)} m`);
  let n = 0, wet = 0; while (h.mode && n < 4000) { stepActor(a, cmd(0, 0, NORTH, 0), land); n++; if (t.levelAt(h.x, h.z) > h.y + 0.5) wet++; }
  assert.ok(n * SIM_DT < 12, `with its owner in ${(n * SIM_DT).toFixed(1)} s`);
  assert.equal(wet, 0, 'without swimming');
  assert.ok(Math.hypot(h.x - a.f.x, h.z - a.f.z) < HORSE.reach);
  // nobody is brought a horse while they are sitting on it
  stepActor(a, cmd(0, 0, 0, BTN.USE), land); assert.equal(a.riding, 1);
  for (let i = 0; i < 100; i++) stepActor(a, cmd(0, 0, 0, 0), land);
  stepActor(a, cmd(0, 0, 0, BTN.WHISTLE), land); assert.equal(h.mode, HMODE.IDLE); assert.ok(a.whT > 0, 'though the whistle is still heard');
});

test('the same inputs give the same result, to the last bit, on foot and on horseback', () => {
  const run = f => {
    const a = makeActor(HUB_X + 3, f.terrain.heightAt(HUB_X + 3, HUB_Z + 3), HUB_Z + 3, true); a.h.x += 6;
    for (let i = 0; i < 3600; i++) stepActor(a, cmd(((i * 37) % 255) - 127, ((i * 91) % 255) - 127, i * 0.013, (i % 97 === 0 ? BTN.JUMP : 0) | (i % 5 ? BTN.SPRINT : 0) | (i % 211 === 0 ? BTN.USE : 0) | (i % 401 === 0 ? BTN.WHISTLE : 0)), f);
    return a;
  };
  assert.deepEqual(run(flat), run(flat)); assert.deepEqual(run(land), run(land));
  const a = run(land); for (const v of [a.f.x, a.f.y, a.f.z, a.f.vx, a.h.x, a.h.y, a.h.z, a.h.hx, a.h.hz, a.h.sp, a.h.stam, a.h.sd]) assert.equal(v, Math.fround(v), 'every number is exactly what the wire carries');
  assert.ok(Math.abs(Math.hypot(a.h.hx, a.h.hz) - 1) < 1e-6, 'and the heading is still a unit vector');
});
