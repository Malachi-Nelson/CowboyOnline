// The guns, as the shared step runs them: what a player's own browser predicts and the server repeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatField } from '../shared/world/field.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { makeActor, stepActor } from '../shared/sim/actor.js';
import { GUNS, AIM, FOCUS, DRAW_STEPS, GF, WEAPON_SHIFT, spreadOf } from '../shared/sim/guns.js';
import { SIN16, COS16 } from '../shared/sim/trig.js';
import { HUB_X, HUB_Z, SIM_DT } from '../shared/constants.js';
import { TAU } from '../shared/math.js';

const flat = flatField();
const W = n => n << WEAPON_SHIFT;                                       // which gun the player wants in hand
const cmd = (buttons = 0, yaw = 0, pitch = 0, mx = 0, mz = 0) => ({ mx, mz, yaw, pitch, buttons });
const actor = () => makeActor(HUB_X + 60, flat.base, HUB_Z + 60, true);
const steps = (a, n, c) => { let shots = 0; for (let i = 0; i < n; i++) { stepActor(a, c, flat); if (a.fired) shots++; } return shots; };
// press the trigger once (one step down, one step up)
const pull = (a, b) => { stepActor(a, cmd(b | BTN.FIRE), flat); const f = a.fired; stepActor(a, cmd(b), flat); return f; };

test('guns: drawing takes 0.4 s, and nothing fires until the gun is in hand', () => {
  const a = actor();
  stepActor(a, cmd(W(1) | BTN.FIRE), flat); assert.equal(a.fired, 0, 'not in hand yet');
  let n = 1; while (a.slot !== 1 && n < 100) { stepActor(a, cmd(W(1)), flat); n++; }
  assert.equal(n, DRAW_STEPS); assert.equal(a.slot, 1);
  assert.equal(pull(a, W(1)), 1, 'now it fires'); assert.equal(a.m1, GUNS[1].mag - 1);
  // put away, and the other gun out
  steps(a, 60, cmd(W(2))); assert.equal(a.slot, 2);
  steps(a, 60, cmd(W(0))); assert.equal(a.slot, 0);
  assert.equal(pull(a, W(0)), 0, 'an empty hand fires nothing');
});

test('guns: one shot a pull, no faster than the hammer or lever allows, however fast the trigger is worked', () => {
  for (const g of [1, 2]) {
    const a = actor(); steps(a, 40, cmd(W(g)));
    // the trigger worked every other step for four seconds: 120 pulls. Once the gun is empty it reloads itself, and
    // each pull fires the round just loaded, so the shots go on; but never closer together than the gun allows.
    const at = []; for (let i = 0; i < 240; i++) { stepActor(a, cmd(W(g) | (i & 1 ? 0 : BTN.FIRE)), flat); if (a.fired) at.push(i); }
    const G = GUNS[g], gaps = at.slice(1).map((v, i) => v - at[i]);
    assert.ok(at.length >= Math.min(G.mag, Math.floor(239 / G.rate) + 1) && at.length <= Math.floor(239 / G.rate) + 1, `${G.short}: ${at.length} shots`);
    assert.ok(Math.min(...gaps) >= G.rate, `${G.short}: shots ${Math.min(...gaps)} steps apart at the closest`);
    assert.equal(Math.max(0, at.length - G.mag), G.spare - a[g === 1 ? 'r1' : 'r2'], 'every shot past the first cylinder or magazine used a spare round');
    // holding the trigger down is one shot, not a stream
    const b = actor(); steps(b, 40, cmd(W(g)));
    assert.equal(steps(b, 120, cmd(W(g) | BTN.FIRE)), 1, `${G.short}: held, it fires once`);
  }
});

test('guns: empty, the hammer clicks and the gun reloads itself a round at a time; firing cuts a reload short', () => {
  const a = actor(); steps(a, 40, cmd(W(1)));
  for (let i = 0; i < 6; i++) { assert.equal(pull(a, W(1)), 1); steps(a, 30, cmd(W(1))); }
  assert.equal(a.m1, 0);
  assert.equal(pull(a, W(1)), 0, 'click'); assert.ok(a.rel > 0, 'and it starts reloading');
  const G = GUNS[1], spare0 = a.r1;
  steps(a, G.first + G.each * 2, cmd(W(1))); assert.equal(a.m1, 3, 'three rounds in');
  assert.equal(pull(a, W(1)), 1, 'a shot in the middle of reloading'); assert.equal(a.rel, 0, 'stops it');
  assert.equal(a.m1, 2); assert.equal(a.r1, spare0 - 3);
  // R loads it to full, using up spare rounds
  stepActor(a, cmd(W(1) | BTN.RELOAD), flat); steps(a, G.first + G.each * 6, cmd(W(1)));
  assert.equal(a.m1, 6); assert.equal(a.r1, spare0 - 7);
  // no spares, no reload
  a.m1 = 0; a.r1 = 0; stepActor(a, cmd(W(1) | BTN.RELOAD), flat); assert.equal(a.rel, 0);
});

test('guns: the shot leaves on the camera line and goes where the view points, aimed or not', () => {
  const a = actor(); steps(a, 40, cmd(W(1) | BTN.AIM));
  const yaw = 9000, pitch = 1200;
  for (let i = 0; i < 40; i++) stepActor(a, cmd(W(1) | BTN.AIM, yaw, pitch), flat);
  stepActor(a, cmd(W(1) | BTN.AIM | BTN.FIRE, yaw, pitch), flat); assert.equal(a.fired, 1);
  const f = a.f, sh = AIM.shoulder;
  assert.ok(Math.abs(a.ox - (f.x + COS16[yaw] * sh)) < 1e-4 && Math.abs(a.oz - (f.z - SIN16[yaw] * sh)) < 1e-4 && Math.abs(a.oy - (f.y + AIM.head + AIM.up)) < 1e-4, 'from beside the head');
  const want = [-SIN16[yaw] * COS16[pitch], SIN16[pitch], -COS16[yaw] * COS16[pitch]], off = Math.acos(a.dx * want[0] + a.dy * want[1] + a.dz * want[2]);
  assert.ok(off <= GUNS[1].aim + 1e-6, `aimed: within the gun's spread (${(off * 1000).toFixed(2)} mrad)`);
  // in the saddle the line is higher and further out, as the camera is
  const r = actor(); r.riding = 1; steps(r, 40, cmd(W(1)));
  stepActor(r, cmd(W(1) | BTN.FIRE), flat); assert.ok(Math.abs(r.oy - (r.f.y + AIM.rideHead + AIM.up)) < 1e-4);
});

test('guns: aimed and still is tight; from the hip, at a run, in the saddle and shot after shot it opens up', () => {
  const spread = (setup, buttons, n = 40) => {
    const a = actor(); setup(a); steps(a, 40, cmd(W(1) | buttons, 0, 0, 0, buttons & BTN.SPRINT ? 127 : 0));
    let worst = 0;
    for (let i = 0; i < n; i++) {
      steps(a, 24, cmd(W(1) | buttons, 0, 0, 0, buttons & BTN.SPRINT ? 127 : 0));
      stepActor(a, cmd(W(1) | buttons | BTN.FIRE, 0, 0, 0, buttons & BTN.SPRINT ? 127 : 0), flat);
      if (a.fired) worst = Math.max(worst, Math.acos(-a.dz * COS16[0] + a.dy * 0));
      a.m1 = 6;
    }
    return worst;
  };
  const aimed = spread(() => {}, BTN.AIM), hip = spread(() => {}, 0), run = spread(() => {}, BTN.SPRINT), saddle = spread(a => { a.riding = 1; }, BTN.AIM);
  assert.ok(aimed < 0.012, `aimed ${aimed.toFixed(4)}`);
  assert.ok(hip > aimed * 2.5, `hip ${hip.toFixed(4)}`); assert.ok(run > hip, `at a run ${run.toFixed(4)}`); assert.ok(saddle > aimed * 2, `in the saddle ${saddle.toFixed(4)}`);
  // and the kick of a shot widens the next until it settles
  const a = actor(); steps(a, 60, cmd(W(1) | BTN.AIM));
  const before = spreadOf(a, GUNS[1], true, 0); stepActor(a, cmd(W(1) | BTN.AIM | BTN.FIRE), flat);
  assert.ok(spreadOf(a, GUNS[1], true, 0) > before + GUNS[1].kick * 0.9, 'kick');
  steps(a, 60, cmd(W(1) | BTN.AIM)); assert.ok(spreadOf(a, GUNS[1], true, 0) < before + 0.012, 'settled');
});

test('focus: steady as a rock and quicker on the hammer, for about seven seconds, then it fills again slowly', () => {
  const a = actor(); steps(a, 40, cmd(W(1) | BTN.AIM));
  stepActor(a, cmd(W(1) | BTN.AIM | BTN.FOCUS), flat); assert.ok(a.gfl & GF.IN_FOCUS);
  assert.equal(spreadOf(a, GUNS[1], true, 0), GUNS[1].focus);
  // six shots in focus come quicker than six without
  const timeSix = (focus) => { const b = actor(); steps(b, 40, cmd(W(1) | BTN.AIM)); let n = 0, shots = 0; while (shots < 6 && n < 600) { stepActor(b, cmd(W(1) | BTN.AIM | (focus ? BTN.FOCUS : 0) | (n & 1 ? 0 : BTN.FIRE)), flat); if (b.fired) shots++; n++; } return n; };
  assert.ok(timeSix(true) < timeSix(false) * 0.55, `in focus ${timeSix(true)} steps, without ${timeSix(false)}`);
  let n = 0; while (a.gfl & GF.IN_FOCUS && n < 1000) { stepActor(a, cmd(W(1) | BTN.AIM | BTN.FOCUS), flat); n++; }
  assert.ok(n * SIM_DT > 6.5 && n * SIM_DT < 7.5, `focus lasted ${(n * SIM_DT).toFixed(1)} s`);
  steps(a, 60, cmd(W(1) | BTN.AIM | BTN.FOCUS)); assert.ok(!(a.gfl & GF.IN_FOCUS), 'spent: no focus until it has filled a little');
  steps(a, Math.ceil(FOCUS.min / FOCUS.refill * 60) + 5, cmd(W(1) | BTN.AIM));
  stepActor(a, cmd(W(1) | BTN.AIM | BTN.FOCUS), flat); assert.ok(a.gfl & GF.IN_FOCUS, 'and back');
  // not without the gun up
  const b = actor(); steps(b, 40, cmd(W(1))); stepActor(b, cmd(W(1) | BTN.FOCUS), flat); assert.ok(!(b.gfl & GF.IN_FOCUS));
});

test('hands up: only with nothing in hand; the body stays where it is; the dead do nothing at all', () => {
  const a = actor(), x0 = a.f.x;
  steps(a, 30, cmd(BTN.HANDS, 0, 0, 0, 127)); assert.ok(a.gfl & GF.HANDS); assert.ok(Math.abs(a.f.x - x0) < 1e-6 && Math.abs(a.f.z - (HUB_Z + 60)) < 1e-6, 'stood still');
  steps(a, 40, cmd(W(1))); steps(a, 10, cmd(W(1) | BTN.HANDS)); assert.ok(!(a.gfl & GF.HANDS), 'not with a gun out');
  a.dead = 1; const z0 = a.f.z;
  assert.equal(steps(a, 60, cmd(W(1) | BTN.FIRE | BTN.AIM, 0, 0, 0, 127)), 0); assert.equal(a.f.z, z0); assert.equal(a.slot, 0);
});

test('guns: the same inputs give the same shots, to the last bit; and each shot is its own', () => {
  const run = () => {
    const a = actor(), out = [];
    for (let i = 0; i < 1800; i++) {
      const b = W((i / 300 | 0) % 3) | (i % 7 === 0 ? BTN.FIRE : 0) | (i % 90 < 60 ? BTN.AIM : 0) | (i % 333 === 0 ? BTN.RELOAD : 0) | (i % 400 < 50 ? BTN.FOCUS : 0) | (i % 5 ? BTN.SPRINT : 0);
      stepActor(a, cmd(b, (i * 37) & 65535, ((i * 13) % 4000) - 2000, ((i * 7) % 255) - 127, 100), flat);
      if (a.fired) out.push([a.ox, a.oy, a.oz, a.dx, a.dy, a.dz]);
    }
    return { a, out };
  };
  const p = run(), q = run();
  assert.deepEqual(p.out, q.out); assert.deepEqual(p.a, q.a);
  assert.ok(p.out.length > 20, `${p.out.length} shots`);
  for (const v of [p.a.bloom, p.a.focus]) assert.equal(v, Math.fround(v));
  // two shots in the same direction from the same place still scatter
  const a = actor(); steps(a, 40, cmd(W(1))); stepActor(a, cmd(W(1) | BTN.FIRE), flat); const d1 = [a.dx, a.dy]; steps(a, 30, cmd(W(1)));
  stepActor(a, cmd(W(1) | BTN.FIRE), flat); assert.notDeepEqual([a.dx, a.dy], d1);
  void TAU;
});
