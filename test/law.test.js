// The law: who sees a crime, who goes to tell, what the lawmen do about it, getting away, giving up, and the cell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, shooter, place } from './helpers.js';
import { Reader } from '../shared/net/codec.js';
import { MSG, EV, NOTE, SS, readSnapshot, readSelf } from '../shared/net/messages.js';
import { HUB_X, HUB_Z, TICK_MS, TICK_RATE, EF_LAW } from '../shared/constants.js';
import { BTN } from '../shared/sim/moveFoot.js';
import { WEAPON_SHIFT } from '../shared/sim/guns.js';
import { makeActor } from '../shared/sim/actor.js';
import { LAW } from '../server/src/core/law.js';
import { RESPAWN_TICKS } from '../server/src/core/combat.js';

const W = n => n << WEAPON_SHIFT;
const notes = raw => { const out = []; for (const b of raw.got) if (b[0] === MSG.SNAPSHOT) { const rd = new Reader(b); rd.u8(); readSnapshot(rd, { self: (t, a, x) => readSelf(x, makeActor(0, 0, 0, true)), event: (t, ev) => { if (ev.type === EV.NOTE) out.push(ev.code); }, despawn() {}, spawn() {}, update() {} }); } return out; };
// a bot that stays where it is put (until something scares it)
const still = (b, x, z, f) => { b.wait = 1e9; place(b.e, x, z, f); b.tx = x; b.tz = z; };
// shoot at a bot until it is down (aiming afresh each time, as it may be running)
function kill(A, b, others = [], max = 12) {
  for (let i = 0; i < max && !b.e.a.dead; i++) { A.at(b.e.s.x, b.e.s.y + (b.e.a.riding ? 2 : 1.15), b.e.s.z); A.hold(1, others); A.fire(others); A.hold(26, others); }
  return b.e.a.dead;
}

test('a crime nobody sees is on nobody\'s books; one a townsman sees is reported, unless the witness is stopped first', () => {
  for (const stop of [false, true]) {
    const r = rig({ bots: 4, lawmen: 0 }), A = shooter(r, 'Ada'), f = r.world.field;
    const town = r.world.bots.filter(b => b.role === 'town'), [v, wit, far] = town;
    for (const b of r.world.bots.filter(b => b.role === 'rider')) place(b.e, HUB_X + 600, HUB_Z + 600, f);
    place(A.p, HUB_X - 60, HUB_Z, f); still(v, HUB_X - 42, HUB_Z, f); still(wit, HUB_X - 52, HUB_Z + 4, f); still(far, HUB_X + 150, HUB_Z, f);
    A.hold(30);
    assert.ok(kill(A, v), 'Vera is down');
    const rec = A.p.law;
    assert.ok(wit.witness, 'and the man beside her saw it'); assert.equal(rec.pending, LAW.murder); assert.equal(rec.witnesses, 1);
    assert.ok(notes(A.raw).includes(NOTE.WITNESS), 'Ada is told she was seen');
    assert.ok(!far.witness, 'nobody 200 m off saw a thing');
    if (stop) {
      assert.ok(kill(A, wit), 'the witness is stopped');
      A.hold(LAW.report / 1 + 40);
      assert.equal(rec.wanted, 0, 'and the law never hears of it'); assert.equal(rec.bounty, 0); assert.equal(rec.witnesses, 0);
    } else {
      A.hold(LAW.report + 10);
      assert.equal(rec.wanted, 1, 'he got to the sheriff'); assert.equal(rec.bounty, LAW.murder); assert.ok(notes(A.raw).includes(NOTE.WANTED));
      assert.ok(Math.hypot(rec.sx - A.p.s.x, rec.sz - A.p.s.z) < 5 && rec.sr > 0, 'the law searches where she was');
    }
  }
});

test('a lawman who sees it acts at once and shoots; out of sight and out of the circle long enough, she gets away', () => {
  const r = rig({ bots: 2, lawmen: 1 }), A = shooter(r, 'Ada'), f = r.world.field, sheriff = r.world.bots[0], v = r.world.bots[1];
  assert.ok(sheriff.e.ef & EF_LAW); assert.equal(sheriff.role, 'law');
  place(A.p, HUB_X - 60, HUB_Z, f); still(v, HUB_X - 45, HUB_Z, f); place(sheriff.e, HUB_X - 30, HUB_Z + 4, f); sheriff.wait = 1e9;
  A.hold(30); A.p.hp = 1e4;                                       // so she lives to try getting away
  assert.ok(kill(A, v));
  const rec = A.p.law; A.hold(4);
  assert.equal(rec.wanted, 2, 'wanted, and seen'); assert.ok(rec.seen); assert.equal(rec.bounty, LAW.murder);
  A.buttons = W(0); A.hold(5 * TICK_RATE);
  assert.ok(A.p.hp < 1e4, 'the sheriff shoots at her'); assert.ok(sheriff.e.a.slot !== 0);
  // off over the river and out of sight
  place(A.p, HUB_X + 420, HUB_Z + 260, f); r.world.moved(A.p); A.hp = 1e4;
  A.hold(LAW.escape + 3 * TICK_RATE);
  assert.equal(rec.wanted, 0, 'got away'); assert.equal(rec.bounty, LAW.murder, 'though the bounty stands'); assert.ok(notes(A.raw).includes(NOTE.ESCAPED));
});

test('hands up near a lawman: taken in, held in the cell for her time, then out at the office door with the slate clean', () => {
  const r = rig({ bots: 2, lawmen: 1 }), A = shooter(r, 'Ada'), f = r.world.field, sheriff = r.world.bots[0], v = r.world.bots[1], J = f.jail;
  place(A.p, HUB_X - 60, HUB_Z, f); still(v, HUB_X - 45, HUB_Z, f); place(sheriff.e, HUB_X - 30, HUB_Z + 4, f); sheriff.wait = 1e9;
  A.hold(30); A.p.hp = 1e4;
  assert.ok(kill(A, v)); const rec = A.p.law; assert.equal(rec.wanted, 2);
  A.buttons = W(0) | BTN.HANDS; let n = 0; while (!A.p.a.jail && n < TICK_RATE * 20) { A.hold(1); n++; } A.hold(1);
  assert.ok(A.p.a.jail, 'arrested'); assert.ok(Math.abs(A.p.s.x - J.x) < 1.8 && Math.abs(A.p.s.z - J.z) < 1.8, 'and in the cell');
  assert.equal(rec.wanted, 0); assert.equal(rec.bounty, 0);
  const secs = LAW.jailBase + LAW.murder * LAW.jailPerDollar, st = A.raw.c.stSent;
  assert.ok(st.flags & SS.JAILED); assert.ok(Math.abs(st.timer - secs) <= 3, `${st.timer} s to serve`);
  // no gun, and no way out
  A.buttons = W(1) | BTN.AIM | BTN.SPRINT; A.mz = 127; A.hold(TICK_RATE * 3);
  assert.equal(A.p.a.slot, 0, 'no gun in the cell'); assert.ok(Math.abs(A.p.s.x - J.x) < 1.8 && Math.abs(A.p.s.z - J.z) < 1.8, 'and no way out');
  A.mz = 0; A.hold(TICK_RATE * (secs + 1));
  assert.ok(!A.p.a.jail, 'released'); assert.ok(Math.hypot(A.p.s.x - J.door.x, A.p.s.z - J.door.z) < 2, 'at the office door');
  assert.ok(notes(A.raw).includes(NOTE.ARRESTED) && notes(A.raw).includes(NOTE.RELEASED));
});

test('killed by the law while wanted, she wakes up in the cell', () => {
  const r = rig({ bots: 2, lawmen: 1 }), A = shooter(r, 'Ada'), f = r.world.field, sheriff = r.world.bots[0], v = r.world.bots[1], J = f.jail;
  place(A.p, HUB_X - 60, HUB_Z, f); still(v, HUB_X - 45, HUB_Z, f); place(sheriff.e, HUB_X - 30, HUB_Z + 4, f); sheriff.wait = 1e9;
  A.hold(30); assert.ok(kill(A, v)); A.buttons = W(0);
  let n = 0; while (!A.p.a.dead && n < 60 * TICK_RATE) { A.hold(1); n++; }
  assert.ok(A.p.a.dead, `the sheriff got her in ${(n / TICK_RATE).toFixed(1)} s`);
  A.hold(RESPAWN_TICKS + 5);
  assert.ok(A.p.a.jail && Math.abs(A.p.s.x - J.x) < 1.8, 'in the cell');
});

test('shooting back is not a crime, and nor is shooting a wanted man', () => {
  const r = rig({ bots: 3, lawmen: 0 }), A = shooter(r, 'Ada'), B = shooter(r, 'Boone'), f = r.world.field;
  const wit = r.world.bots.find(b => b.role === 'town');
  for (const b of r.world.bots) if (b !== wit) place(b.e, HUB_X + 600, HUB_Z + 600, f);
  place(A.p, HUB_X - 60, HUB_Z, f); place(B.p, HUB_X - 40, HUB_Z, f); still(wit, HUB_X - 50, HUB_Z + 5, f);
  A.hold(30, [B]); B.hold(1, [A]);
  // Boone shoots first
  B.at(A.p.s.x, A.p.s.y + 1.15, A.p.s.z); B.hold(10, [A]); B.fire([A]); B.hold(2, [A]);
  assert.ok(A.p.hp < 100); assert.equal(B.p.law.pending, LAW.assault, 'Boone is seen doing it');
  A.at(B.p.s.x, B.p.s.y + 1.15, B.p.s.z); A.hold(10, [B]); A.fire([B]); A.hold(2, [B]);
  assert.ok(B.p.hp < 100, 'Ada answers'); assert.ok(!A.p.law || !A.p.law.pending, 'and that is no crime');
  // once Boone is wanted, anyone may shoot him
  A.hold(LAW.report + 10, [B]); assert.ok(B.p.law.wanted);
  const C = shooter(r, 'Cora'); place(C.p, HUB_X - 55, HUB_Z - 3, f); C.hold(30, [A, B]); C.at(B.p.s.x, B.p.s.y + 1.15, B.p.s.z); C.fire([A, B]); C.hold(2, [A, B]);
  assert.ok(!C.p.law || !C.p.law.pending);
});

test('a lawman killed sends a posse: three riders brought in out of sight, riding her down', () => {
  const r = rig({ bots: 3, lawmen: 2 }), A = shooter(r, 'Ada'), f = r.world.field, [sheriff, deputy] = r.world.bots;
  place(A.p, HUB_X - 60, HUB_Z, f); place(sheriff.e, HUB_X - 35, HUB_Z + 4, f); sheriff.wait = 1e9; place(deputy.e, HUB_X - 30, HUB_Z - 4, f); deputy.wait = 1e9;
  A.hold(30); A.p.hp = 1e5;
  assert.ok(kill(A, sheriff), 'the sheriff is down');
  A.hold(4);
  const rec = A.p.law; assert.equal(rec.wanted, 3, 'dead or alive');
  const P = r.world.posse; assert.equal(P.length, LAW.posseSize, 'a posse rode out');
  for (const b of P) { assert.ok(b.e.ef & EF_LAW); assert.ok(b.e.a.riding, 'mounted'); const d = Math.hypot(b.e.s.x - A.p.s.x, b.e.s.z - A.p.s.z); assert.ok(d > 120, `brought in ${d.toFixed(0)} m off`); }
  const d0 = Math.min(...P.map(b => Math.hypot(b.e.s.x - A.p.s.x, b.e.s.z - A.p.s.z)));
  A.buttons = W(0); A.hold(10 * TICK_RATE);
  const d1 = Math.min(...P.map(b => Math.hypot(b.e.s.x - A.p.s.x, b.e.s.z - A.p.s.z)));
  assert.ok(d1 < d0 - 60, `they closed from ${d0.toFixed(0)} m to ${d1.toFixed(0)} m`);
  assert.ok(notes(A.raw).includes(NOTE.POSSE));
});
