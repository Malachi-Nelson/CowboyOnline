// Gunfights, judged by the server: where shots land, what stops them, lag compensation at 150 ms of ping, and the
// cheats a client might try (shooting faster than the gun, shooting the past, claiming hits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, aim, shooter, place } from './helpers.js';
import { Writer, Reader } from '../shared/net/codec.js';
import { MSG, EV, UM, ZONE, STRUCK, encHello, encInputHead, encCmd, encHints, readSnapshot, readSelf } from '../shared/net/messages.js';
import { HUB_X, HUB_Z, TICK_MS, REWIND_MAX, HP_MAX, KIND_HORSE } from '../shared/constants.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { GUNS, AIM, WEAPON_SHIFT } from '../shared/sim/guns.js';
import { SIN16, COS16 } from '../shared/sim/trig.js';
import { makeActor } from '../shared/sim/actor.js';
import { rng32, TAU } from '../shared/math.js';
import { RESPAWN_TICKS } from '../server/src/core/combat.js';

const w = new Writer(512), W = n => n << WEAPON_SHIFT;
const EAST = 49152;
const events = (raw, type) => { const out = []; for (const b of raw.got) if (b[0] === MSG.SNAPSHOT) { const rd = new Reader(b); rd.u8(); readSnapshot(rd, { self: (t, a, x) => readSelf(x, makeActor(0, 0, 0, true)), event: (t, ev) => { if (ev.type === type) out.push(ev); }, despawn() {}, spawn() {}, update() {} }); } return out; };

test('a shot lands where it is aimed: 34 to the body, three to drop a man, and one to the head', () => {
  const r = rig(), A = shooter(r, 'Ada'), B = shooter(r, 'Boone'), f = r.world.field;
  place(A.p, HUB_X - 60, HUB_Z, f); place(B.p, HUB_X - 40, HUB_Z, f); B.buttons = W(0);
  A.hold(30); B.hold(1);
  const at = (dy) => { const t = aim(A.p.a, B.p.s.x, B.p.s.y + dy, B.p.s.z); A.yaw = t.yaw; A.pitch = t.pitch; };
  at(1.2); A.hold(20); A.fire();
  assert.equal(B.p.hp, HP_MAX - GUNS[1].dmg, 'one in the body');
  const hits = events(A.raw, EV.HIT); assert.equal(hits.length, 1); assert.equal(hits[0].zone, ZONE.BODY); assert.equal(hits[0].id, B.p.id); assert.equal(hits[0].hp, HP_MAX - 34);
  A.hold(30); A.fire(); A.hold(30); A.fire();
  assert.ok(B.p.a.dead, 'three in the body'); assert.equal(events(B.raw, EV.DIE).length, 1, 'and he hears it');
  // up again, and this time in the head
  for (let i = 0; i < RESPAWN_TICKS + 5; i++) { B.send(); r.run(TICK_MS); }
  assert.ok(!B.p.a.dead && B.p.hp === HP_MAX, 'back on his feet');
  place(B.p, HUB_X - 40, HUB_Z, f); r.world.moved(B.p); B.hold(10); A.hold(2);
  at(1.63); A.hold(20); A.fire();
  assert.ok(B.p.a.dead, 'one in the head'); assert.equal(events(A.raw, EV.DIE).at(-1).zone, ZONE.HEAD);
  // a long way off, a revolver does less
  const far = rig(), C = shooter(far, 'Cora'), D = shooter(far, 'Dell'), g = far.world.field; place(C.p, HUB_X - 100, HUB_Z, g); place(D.p, HUB_X - 10, HUB_Z, g); D.buttons = W(0);
  C.buttons |= BTN.FOCUS;                                         // steadied, so the spread does not decide it
  C.hold(30); D.hold(1); const t = aim(C.p.a, D.p.s.x, D.p.s.y + 1.2, D.p.s.z); C.yaw = t.yaw; C.pitch = t.pitch; C.hold(30); C.fire();
  assert.ok(D.p.hp > HP_MAX - 34 && D.p.hp < HP_MAX, `at 90 m: ${HP_MAX - D.p.hp} damage`);
});

test('a building, the ground and a horse all stop a bullet; the horse takes no harm', () => {
  const r = rig(), A = shooter(r, 'Ada'), B = shooter(r, 'Boone'), f = r.world.field;
  // Boone stands behind the sheriff's office, Ada in the street in front of it
  const sheriff = f.buildings.find(b => b.sign === 'SHERIFF');
  place(A.p, (sheriff.x0 + sheriff.x1) / 2, HUB_Z, f); place(B.p, (sheriff.x0 + sheriff.x1) / 2, sheriff.z1 + 3, f); B.buttons = W(0);
  A.hold(30); B.hold(1);
  let t = aim(A.p.a, B.p.s.x, B.p.s.y + 1.2, B.p.s.z); A.yaw = t.yaw; A.pitch = t.pitch; A.hold(20); A.fire();
  assert.equal(B.p.hp, HP_MAX, 'not through the wall'); assert.equal(events(A.raw, EV.SHOT).at(-1).struck, STRUCK.WOOD);
  // at the ground in front of Ada
  t = aim(A.p.a, A.p.s.x - 6, A.p.s.y, A.p.s.z); A.yaw = t.yaw; A.pitch = t.pitch; A.hold(25); A.fire();
  const sh = events(A.raw, EV.SHOT).at(-1); assert.equal(sh.struck, STRUCK.GROUND); assert.ok(sh.dist > 5 && sh.dist < 8, `${sh.dist} m`);
  // a horse between them: Boone in the open, his horse broadside in the line of fire
  place(B.p, A.p.s.x - 30, HUB_Z, f); const h = B.p.a.h; h.x = Math.fround(A.p.s.x - 15); h.z = Math.fround(HUB_Z); h.y = f.base; h.hx = 0; h.hz = 1; h.sp = 0;
  B.hold(3); A.hold(3);
  t = aim(A.p.a, B.p.s.x, B.p.s.y + 1.2, B.p.s.z); A.yaw = t.yaw; A.pitch = t.pitch; A.hold(25); A.fire();
  assert.equal(B.p.hp, HP_MAX, 'the horse took it'); const hit = events(A.raw, EV.HIT).at(-1); assert.equal(hit.zone, ZONE.HORSE); assert.equal(r.world.ents.get(hit.id).kind, KIND_HORSE);
});

// Two players at 150 ms of ping (75 ms each way, and some jitter). Boone runs back and forth across the street;
// Ada keeps her sights on him as her screen shows him, and fires every two thirds of a second.
function duel(compensate) {
  const r = rig(), ja = rng32(5), jb = rng32(6), lag = j => () => 75 + j() * 10;
  let target = null, shots = 0, n = 0;
  const A = r.join('Ada', lag(ja), { sample: (c, s) => {
    c.mx = 0; c.mz = 0; c.buttons = W(1) | BTN.AIM; n++;
    const e = target && s.ents.get(target);
    if (e) { const t = aim(s.a, e.x, e.y + 1.15, e.z); c.yaw = t.yaw; c.pitch = t.pitch; if (n % 40 === 0 && s.a.slot === 1 && s.a.aimT > 30) c.buttons |= BTN.FIRE; }
  } });
  A.onshot = () => { shots++; };                                  // shots her own screen showed going off
  let k = 0;
  const B = r.join('Boone', lag(jb), { sample: c => { k++; c.yaw = EAST; c.mz = 0; c.mx = (k / 55 | 0) % 2 ? 127 : -127; c.buttons = W(0); } });
  r.run(300);
  const pa = r.world.people.find(p => p.name === 'Ada'), pb = r.world.people.find(p => p.name === 'Boone'), f = r.world.field;
  place(pa, HUB_X - 60, HUB_Z, f); place(pb, HUB_X - 35, HUB_Z, f); target = B.id;
  if (!compensate) { const fire = r.world.combat.fire.bind(r.world.combat); r.world.combat.fire = (e, view, hint) => fire(e, r.world.serverNow(), null); }
  r.run(1500); shots = 0; const hits0 = r.world.combat.stats.hits, c0 = A.stats.corrections; let speedSum = 0, speedN = 0;
  for (let i = 0; i < 400; i++) { pb.hp = HP_MAX; r.run(50); speedSum += Math.hypot(pb.s.vx, pb.s.vz); speedN++; }
  return { shots, hits: r.world.combat.stats.hits - hits0, corrections: A.stats.corrections - c0, speed: speedSum / speedN, stats: r.world.combat.stats };
}

test('lag compensation: at 150 ms of ping a running man is hit where the shooter saw him; without it the same shots miss', () => {
  const on = duel(true), off = duel(false);
  console.log(`    compensated ${on.hits}/${on.shots}, not ${off.hits}/${off.shots}; Boone at ${on.speed.toFixed(1)} m/s; rewound up to ${on.stats.rewindMsMax.toFixed(0)} ms`);
  assert.ok(on.speed > 2.5, `Boone ran at ${on.speed.toFixed(1)} m/s on average`);
  assert.ok(on.shots >= 15 && on.stats.shots >= on.shots, `${on.shots} shots`);
  assert.ok(on.hits >= on.shots * 0.85, `compensated: ${on.hits} of ${on.shots} hit`);
  assert.ok(off.hits <= off.shots * 0.45, `not compensated: ${off.hits} of ${off.shots} hit`);
  assert.ok(on.stats.rewindMsMax <= REWIND_MAX && on.stats.hinted >= on.shots * 0.9, `rewound up to ${on.stats.rewindMsMax.toFixed(0)} ms; ${on.stats.hinted} hinted`);
  assert.equal(on.corrections, 0, 'and the shooter\'s own prediction (the shots, the reloads) never needed putting right');
});

test('the server rewinds at most 400 ms, whatever the client says it saw', () => {
  const r = rig(), A = shooter(r, 'Ada'), B = shooter(r, 'Boone'), f = r.world.field;
  place(A.p, HUB_X - 60, HUB_Z + 3, f); place(B.p, HUB_X - 20, HUB_Z - 3, f); B.buttons = W(0); B.yaw = 16384; B.mz = 127;   // Boone jogs west
  A.buttons |= BTN.FOCUS;                                         // steadied, so only the timing decides it
  for (let i = 0; i < 60; i++) { A.send(); B.send(); r.run(TICK_MS); }
  // Ada says she is looking at the world as it was k ticks ago, and aims at exactly where Boone was then
  const claim = k => {
    const ms = (r.world.tick - k) * TICK_MS, then = r.world.positionAt(B.p, r.world.tick - k, {}), t = aim(A.p.a, then.x, then.y + 1.2, then.z);
    A.yaw = t.yaw; A.pitch = t.pitch; A.viewAge = Math.floor(r.world.serverNow()) - ms; A.hints = [{ target: B.p.id, ms }];
    const hp = B.p.hp, before = r.world.combat.stats.clamped; A.send(2); B.send(); r.run(TICK_MS);
    for (let i = 0; i < 40; i++) { A.send(); B.send(); r.run(TICK_MS); }               // the hammer back again
    return { hit: B.p.hp < hp, clamped: r.world.combat.stats.clamped > before };
  };
  const second = claim(20);
  assert.ok(second.clamped, 'a second back: the claim was cut back to 400 ms'); assert.ok(!second.hit, 'and the shot missed: he had moved on');
  const quarter = claim(5);
  assert.ok(!quarter.clamped && quarter.hit, 'a quarter of a second back is fair, and hits');
});

test('no shot faster than the gun allows however the trigger is worked; and no way to tell the server what you hit', () => {
  const r = rig(), A = shooter(r, 'Ada'), B = shooter(r, 'Boone'), f = r.world.field;
  place(A.p, HUB_X - 60, HUB_Z, f); place(B.p, HUB_X - 30, HUB_Z, f); B.buttons = W(0);
  A.hold(30); A.pitch = 3000;                                    // up into the sky
  const shots0 = r.world.combat.stats.shots;
  // the trigger in every other input, and inputs sent three times as fast as real time
  let seq = 4000;
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 3; k++) { encInputHead(w, seq, 3, 0); for (let j = 0; j < 3; j++) encCmd(w, 0, 0, 0, 3000, W(1) | BTN.AIM | ((seq + j) & 1 ? BTN.FIRE : 0)); encHints(w, []); A.raw.send(w.bytes()); seq += 3; }
    r.run(TICK_MS);
  }
  const shots = r.world.combat.stats.shots - shots0;
  assert.ok(shots <= Math.ceil(2000 / (GUNS[1].rate * 1000 / 60)) + 1, `${shots} shots in two seconds`);
  // more hints than inputs: thrown out with the connection
  encInputHead(w, seq, 1, 0); encCmd(w, 0, 0, 0, 0, W(1)); encHints(w, [{ seq, target: B.p.id, ms: 0 }, { seq, target: B.p.id, ms: 0 }]); A.raw.send(w.bytes());
  assert.ok(A.raw.closed, 'a packet with more hints than inputs ends the connection');
  // a "hit" message: there is no such thing, and saying one ends the connection too
  const C = shooter(r, 'Cora'); place(C.p, HUB_X - 50, HUB_Z, f);
  w.reset(); w.u8(9); w.u16(B.p.id); w.u8(ZONE.HEAD); C.raw.send(w.bytes());
  assert.ok(C.raw.closed); assert.equal(B.p.hp, HP_MAX);
  // a hint naming Boone on a shot that goes nowhere near him harms nobody
  const D = shooter(r, 'Dell'); place(D.p, HUB_X - 70, HUB_Z, f); D.hold(30); D.pitch = 3000; D.hints = [{ target: B.p.id, ms: Math.floor(r.world.serverNow()) - 100 }]; D.fire(); D.hold(2);
  assert.equal(B.p.hp, HP_MAX);
});

test('a player who dies is down six seconds, then up on the street with full health and loaded guns', () => {
  const r = rig(), A = shooter(r, 'Ada');
  const B = r.join('Boone', 75, { sample: c => { c.buttons = W(1) | BTN.AIM; } });
  r.run(400); const pb = r.world.people.find(p => p.name === 'Boone'), f = r.world.field;
  place(A.p, HUB_X - 60, HUB_Z, f); place(pb, HUB_X - 40, HUB_Z, f);
  r.run(1000); const c0 = B.stats.corrections;
  A.hold(30); const t = aim(A.p.a, pb.s.x, pb.s.y + 1.63, pb.s.z); A.yaw = t.yaw; A.pitch = t.pitch; A.hold(20); A.fire(); r.run(200);
  assert.ok(pb.a.dead && B.a.dead, 'dead, on both sides'); assert.equal(B.status.hp, 0); assert.ok(B.status.timer >= 5);
  r.run(RESPAWN_TICKS * TICK_MS + 400);
  assert.ok(!pb.a.dead && pb.hp === HP_MAX && B.status.hp === HP_MAX, 'up again'); assert.equal(pb.a.m1, GUNS[1].mag); assert.ok(pb.a.r1 >= GUNS[1].spare);
  assert.ok(Math.abs(pb.s.x - HUB_X) <= 23 && Math.abs(pb.s.z - HUB_Z) <= 5, 'on the main street');
  assert.ok(B.stats.corrections - c0 <= 2, `${B.stats.corrections - c0} corrections: being shot dead and being stood up again`);
});

test('getting up again is a jump, not a slide: everyone watching is told the body was put there', () => {
  const r = rig(), A = shooter(r, 'Ada'), f = r.world.field;
  const B = r.join('Boone', 75, { sample: c => { c.buttons = W(0); } }), C = r.join('Cora', 75, { sample: c => { c.buttons = W(0); } });
  r.run(400); const pb = r.world.people.find(p => p.name === 'Boone'), pc = r.world.people.find(p => p.name === 'Cora');
  place(A.p, HUB_X - 60, HUB_Z, f); place(pb, HUB_X - 40, HUB_Z, f); place(pc, HUB_X - 30, HUB_Z + 12, f);
  for (const p of [A.p, pb, pc]) r.world.moved(p);
  r.run(1000);
  // he gets up 9 m from where he fell: too near for a viewer to tell a jump from a dash by distance alone
  const up = [HUB_X - 31, HUB_Z]; r.world.spawnPoint = () => up;
  A.hold(30); const t = aim(A.p.a, pb.s.x, pb.s.y + 1.63, pb.s.z); A.yaw = t.yaw; A.pitch = t.pitch; A.hold(20); A.fire(); r.run(200);
  assert.ok(pb.a.dead); const fell = pb.s.x, n0 = A.raw.got.length;
  const seen = [];
  for (let i = 0; i < (RESPAWN_TICKS * TICK_MS + 1000) / 16; i++) { r.run(16); const e = C.ents.get(pb.id); if (e) seen.push(e.x); }
  assert.ok(!pb.a.dead && Math.abs(pb.s.x - up[0]) < 1, 'up again where the world put him');
  let puts = 0;
  for (const b of A.raw.got.slice(n0)) if (b[0] === MSG.SNAPSHOT) { const rd = new Reader(b); rd.u8(); readSnapshot(rd, { self: (tk, a, x) => readSelf(x, makeActor(0, 0, 0, true)), despawn() {}, spawn() {}, update: (tk, id, mask) => { if (id === pb.id && (mask & UM.PUT)) puts++; } }); }
  assert.equal(puts, 1, 'the update that stood him up said he was put there, once');
  const between = seen.filter(x => x > fell + 1 && x < up[0] - 1);
  assert.equal(between.length, 0, `Cora never drew him partway (${between.map(x => (x - HUB_X).toFixed(1)).join(', ')})`);
  assert.ok(seen.some(x => Math.abs(x - fell) < 1) && seen.some(x => Math.abs(x - up[0]) < 1), 'she saw him fall there and get up here');
});
