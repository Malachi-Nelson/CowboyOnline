// The authoritative world: who may join, what each player is told, and what a player cannot get away with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, rawClient } from './helpers.js';
import { World } from '../server/src/core/world.js';
import { Writer, Reader } from '../shared/net/codec.js';
import { MSG, REJECT, UM, encHello, encInputHead, encCmd, decWelcome, readSnapshot, readSelf } from '../shared/net/messages.js';
import { SNAPSHOT_BUDGET, HUB_X, HUB_Z, VIEW_ENTER, VIEW_LEAVE, PROTOCOL_VERSION, TICK_RATE, KIND_HORSE, KIND_PLAYER, ST_RIDING, ST_WHISTLE, DAY_MS } from '../shared/constants.js';
import { FOOT, BTN } from '../shared/sim/moveFoot.js';
import { HORSE } from '../shared/sim/moveHorse.js';
import { makeActor, AF } from '../shared/sim/actor.js';

const w = new Writer(256);
const hello = (name = 'Tester', token = '') => encHello(w, name, token);
const inputs = (first, n, mx, mz, yaw, buttons) => { encInputHead(w, first, n, 0); for (let i = 0; i < n; i++) encCmd(w, mx, mz, yaw, buttons); return w.bytes(); };
const WEST = 16384;                          // a quarter turn left of north: straight down the main street
const welcomeOf = raw => { const i = raw.types().indexOf(MSG.WELCOME); assert.ok(i >= 0, 'welcomed'); const a = makeActor(0, 0, 0, true), o = decWelcome(raw.reader(i), a); o.actor = a; return o; };
// put a player in the middle of the main street, where there is a clear run west
const onStreet = (world, p, dx = 0) => { p.s.x = Math.fround(HUB_X + dx); p.s.z = HUB_Z; p.s.y = world.field.base; if (p.a.h) { p.a.h.x = p.s.x; p.a.h.z = Math.fround(HUB_Z + 2); p.a.h.y = world.field.base; p.a.h.hx = -1; p.a.h.hz = 0; } };   // facing west, down the street
const scratch = makeActor(0, 0, 0, true), self = (t, a, r) => readSelf(r, scratch);

test('a newcomer is welcomed with a horse of their own, and the bots make room', () => {
  const world = new World({ bots: 63, now: () => 0 });
  assert.equal(world.bodies, 63);
  const a = rawClient(world); a.send(hello('Ada'));
  const wa = welcomeOf(a);
  assert.equal(wa.proto, PROTOCOL_VERSION); assert.equal(wa.tickRate, TICK_RATE); assert.equal(wa.token.length, 24);
  assert.ok(Math.abs(wa.x - HUB_X) <= 22.5 && Math.abs(wa.z - HUB_Z) <= 5, 'spawned on the main street');
  assert.equal(wa.dayMs, DAY_MS / 3, 'at eight in the morning');
  const h = wa.actor.h, p = a.c.player;
  assert.ok(h && wa.horseId === p.horse.id, 'the welcome says which horse is theirs');
  assert.ok(Math.hypot(h.x - wa.x, h.z - wa.z) < 4, 'and it is standing beside them');
  assert.equal(world.ents.get(wa.horseId).kind, KIND_HORSE);
  assert.equal(world.bots.length, 63); assert.equal(world.bodies, 64);
  const b = rawClient(world); b.send(hello('Boone'));
  assert.equal(world.bots.length, 62); assert.equal(world.people.length, 2); assert.equal(world.bodies, 64);
  assert.notEqual(welcomeOf(b).id, wa.id);
  // the world is lived in: townsfolk on foot, riders on the roads, nobody standing in the river or inside a wall
  const riders = world.bots.filter(x => x.role === 'rider'), town = world.bots.filter(x => x.role === 'town'), T = world.field.terrain;
  assert.ok(riders.length >= 18 && town.length >= 38, `${riders.length} riders, ${town.length} townsfolk`);
  assert.ok(riders.every(x => x.e.a.riding && x.e.horse));
  for (const x of world.bots) assert.ok(T.levelAt(x.e.s.x, x.e.s.z) - x.e.s.y < 0.6, `${x.e.name} starts on dry land`);
});

test('an old client, a full world and a nonsense message are all turned away', () => {
  const world = new World({ bots: 0, maxPlayers: 2, now: () => 0 });
  const old = rawClient(world); w.reset(); w.u8(MSG.HELLO); w.u16(PROTOCOL_VERSION - 1); w.str('Old'); w.str(''); old.send(w.bytes());
  assert.deepEqual(old.types(), [MSG.REJECT]); assert.equal(old.reader(0).u8(), REJECT.VERSION); assert.ok(old.closed);
  rawClient(world).send(hello('One')); rawClient(world).send(hello('Two'));
  const third = rawClient(world); third.send(hello('Three'));
  assert.deepEqual(third.types(), [MSG.REJECT]); assert.equal(third.reader(0).u8(), REJECT.FULL); assert.ok(third.closed);
  assert.equal(world.people.length, 2);
  const junk = rawClient(world); junk.send(new Uint8Array([MSG.HELLO, 1]));                   // cut short
  assert.ok(junk.closed, 'a message that does not parse closes the connection');
  const odd = rawClient(world); odd.send(new Uint8Array([99, 1, 2, 3]));
  assert.ok(odd.closed, 'so does an unknown type');
  assert.equal(world.clients.size, 2);
});

test('a connection that floods is closed, and cannot talk its way back in', () => {
  const world = new World({ bots: 0, now: () => 0 });
  const a = rawClient(world); a.send(hello());
  for (let i = 0; i < 300 && !a.closed; i++) a.send(inputs(1 + i * 3, 3, 0, 0, 0, 0));
  assert.ok(a.closed);
  // whatever was still in the pipe when it was closed is ignored: no second body, nothing left attached
  const before = world.list.length; a.got.length = 0;
  a.send(hello('Ghost')); a.send(inputs(1, 3, 0, 127, 0, 0));
  assert.equal(world.list.length, before); assert.equal(a.got.length, 0); assert.equal(world.clients.size, 0);
  assert.ok(world.people.every(p => p.client === null));
});

test('every snapshot fits the budget and the client ends up with exactly what the server thinks it has', () => {
  // the worst case for one player: 63 bots and their horses milling about within 30 m
  const world = new World({ bots: 63, roam: 30, now: () => 0 });
  const a = rawClient(world); a.send(hello());
  const mirror = new Map(); let biggest = 0, updates = 0, holds = 0, horses = 0;
  const h = {
    self, despawn: id => { assert.ok(mirror.delete(id), 'only known entities are despawned'); },
    spawn: (t, id, kind, ef, name, qx, qy, qz, yaw, st, owner) => {
      assert.ok(!mirror.has(id), 'no entity is spawned twice'); mirror.set(id, { qx, qy, qz, yaw, st });
      if (kind === KIND_HORSE) { horses++; assert.equal(world.ents.get(id).owner.id, owner, 'a horse arrives with its owner named'); } else assert.equal(owner, 0);
    },
    update: (t, id, mask, hold, dx, dy, dz, yaw, st) => {
      const m = mirror.get(id); assert.ok(m, 'no update for an entity that was never spawned'); updates++; if (mask & UM.HOLD) holds++;
      m.qx += dx; m.qy += dy; m.qz += dz; if (yaw >= 0) m.yaw = yaw; if (st >= 0) m.st = st;
    },
  };
  let seq = 1; onStreet(world, a.c.player);
  for (let t = 0; t < 1200; t++) {
    a.send(inputs(seq, 3, 0, 127, (t * 40) & 65535, BTN.SPRINT)); seq += 3;
    world.step();
    for (const b of a.got.splice(0)) {
      if (b[0] !== MSG.SNAPSHOT) continue;
      assert.ok(b.length <= SNAPSHOT_BUDGET, `snapshot of ${b.length} bytes`); if (b.length > biggest) biggest = b.length;
      const r = new Reader(b); r.u8(); readSnapshot(r, h); assert.equal(r.left, 0);
    }
  }
  assert.equal(mirror.size, world.list.length - 2, 'everyone is in view, bar the player and their own horse');
  assert.equal(horses, 21);
  assert.ok(!mirror.has(a.c.player.horse.id), 'a player is never sent their own horse as somebody else');
  for (const [id, m] of mirror) { const rec = a.c.view.get(id); assert.deepEqual(m, { qx: rec.qx, qy: rec.qy, qz: rec.qz, yaw: rec.yaw, st: rec.st }); }
  assert.ok(updates > 20000 && holds > 50, `updates ${updates}, holds ${holds}`);
  assert.ok(biggest > 300, `the crowd makes big snapshots (${biggest})`);
});

test('interest: in at 384 m, out at 448 m, and nothing in between flickers', () => {
  const world = new World({ bots: 0, now: () => 0 });
  const a = rawClient(world), b = rawClient(world); a.send(hello('A')); b.send(hello('B'));
  const pa = a.c.player, pb = b.c.player, place = d => { pb.s.x = pa.s.x + d; pb.s.z = pa.s.z; for (let i = 0; i < 6; i++) world.step(); return a.c.view.has(pb.id); };
  assert.equal(place(5), true);
  assert.equal(place(VIEW_ENTER + 30), true, 'still seen between the two radii when it was seen before');
  assert.equal(place(VIEW_LEAVE + 2), false);
  assert.equal(place(VIEW_ENTER + 30), false, 'not seen between the two radii when it was not seen before');
  assert.equal(place(VIEW_ENTER - 2), true);
  // and the wire agrees: a despawn then a spawn for B
  const ev = []; const h = { self, despawn: id => { if (id === pb.id) ev.push('gone ' + id); }, spawn: (t, id) => { if (id === pb.id) ev.push('spawn ' + id); }, update() {} };
  for (const m of a.got) if (m[0] === MSG.SNAPSHOT) { const r = new Reader(m); r.u8(); readSnapshot(r, h); }
  assert.deepEqual(ev, [`spawn ${pb.id}`, `gone ${pb.id}`, `spawn ${pb.id}`]);
});

test('a player nobody can see costs nothing, and a horse standing still costs nothing either', () => {
  const world = new World({ bots: 63, spawn: 'spread', now: () => 0 });
  const a = rawClient(world); a.send(hello());
  // spread worlds scatter people too; walk nowhere and count what arrives
  for (let i = 0; i < 400; i++) world.step();
  const sizes = a.got.filter(b => b[0] === MSG.SNAPSHOT).map(b => b.length);
  assert.ok(a.c.view.size <= 12, `few neighbours (${a.c.view.size})`);
  const median = sizes.sort((p, q) => p - q)[sizes.length >> 1];
  assert.ok(median <= 64, `median snapshot ${median} bytes`);
  // alone on the street with their own horse at rest: the snapshot is the header and three empty counts
  const quiet = new World({ bots: 0, now: () => 0 }), q = rawClient(quiet); q.send(hello());
  for (let i = 0; i < 40; i++) quiet.step();
  assert.equal(q.got.at(-1).length, 36);
});

test('the horse is part of what a player is told about themselves, but only when it has changed', () => {
  const world = new World({ bots: 0, now: () => 0 }), a = rawClient(world); a.send(hello());
  const p = a.c.player; onStreet(world, p); world.step(); a.got.length = 0;
  const blocks = () => { let n = 0; for (const b of a.got.splice(0)) if (b[0] === MSG.SNAPSHOT) { const r = new Reader(b); r.u8(); r.u32(); r.u16(); if (readSelf(r, scratch) & AF.HORSE_BLOCK) n++; } return n; };
  let seq = 1; const go = (n, mz, btn) => { for (let i = 0; i < n; i++) { a.send(inputs(seq, 3, 0, mz, WEST, btn)); seq += 3; world.step(); } };
  go(20, 0, 0); assert.equal(blocks(), 0, 'standing: nothing to say about the horse');
  go(1, 0, BTN.USE); assert.equal(p.a.riding, 1); go(40, 127, 0);
  assert.equal(blocks(), 40, 'riding: every snapshot carries it'); assert.equal(scratch.h.x, p.a.h.x); assert.equal(scratch.riding, 1);
  go(1, 0, BTN.USE); assert.equal(p.a.riding, 0); go(200, 0, 0); a.got.length = 0;
  go(20, 0, 0); assert.equal(blocks(), 0, 'and once it has come to rest again, nothing');
});

test('riding: others are sent the horse, and the rider only as "in the saddle"', () => {
  const world = new World({ bots: 0, now: () => 0 });
  const a = rawClient(world), b = rawClient(world); a.send(hello('A')); b.send(hello('B'));
  const pa = a.c.player, pb = b.c.player; onStreet(world, pa, 0); onStreet(world, pb, 30);
  for (let i = 0; i < 10; i++) world.step(); b.got.length = 0;
  const seen = new Map(), log = [];
  const h = { self, despawn() {}, spawn() {}, update: (t, id, mask, hold, dx, dy, dz, yaw, st) => { const s = seen.get(id) || { moves: 0, st: -1 }; if (mask & UM.POS) { s.moves++; s.far = Math.max(s.far || 0, Math.hypot(dx, dz) / 32); } if (st >= 0) { s.st = st; log.push([id, st]); } seen.set(id, s); } };
  const read = () => { for (const m of b.got.splice(0)) if (m[0] === MSG.SNAPSHOT) { const r = new Reader(m); r.u8(); readSnapshot(r, h); } };
  let seq = 1; const go = (n, mz, btn) => { for (let i = 0; i < n; i++) { a.send(inputs(seq, 3, 0, mz, WEST, btn)); seq += 3; world.step(); } read(); };
  go(1, 0, BTN.WHISTLE); go(12, 0, 0);
  assert.ok(log.some(([id, st]) => id === pa.id && (st & ST_WHISTLE)), 'the whistle is heard');
  assert.ok(log.some(([id, st]) => id === pa.id && !(st & ST_WHISTLE)), 'and stops');
  go(60, 0, 0); go(1, 0, BTN.USE); go(2, 0, 0); assert.equal(pa.a.riding, 1);
  assert.ok(seen.get(pa.id).st & ST_RIDING, 'B is told A is in the saddle');
  seen.clear(); go(100, 127, BTN.SPRINT);
  assert.ok(!seen.has(pa.id), 'the rider sends nothing of their own while riding');
  assert.ok(seen.get(pa.horse.id).moves > 80, 'the horse does');
  assert.ok(Math.hypot(pa.s.x - HUB_X, pa.s.z - HUB_Z) > 30 && pa.s.x === pa.a.h.x, 'and on the server the rider is where the horse is');
  seen.clear(); go(1, 127, BTN.USE); go(5, 0, 0);
  assert.equal(seen.get(pa.id).st & ST_RIDING, 0); assert.ok(seen.get(pa.id).far > 30, 'stepping down, the rider is told to be where they now are, in one go');
});

test('dropping and coming back within the grace period keeps the same body and the same horse', () => {
  const r = rig();
  const world = r.world, a = r.raw(); a.send(hello('Ada'));
  const wa = welcomeOf(a), p = a.c.player; onStreet(world, p);
  let seq = 1; for (let i = 0; i < 40; i++) { a.send(inputs(seq, 3, 0, 127, WEST, BTN.SPRINT)); seq += 3; r.run(50); }
  const moved = Math.hypot(p.s.x - HUB_X, p.s.z - HUB_Z); assert.ok(moved > 8, `ran ${moved.toFixed(1)} m`);
  world.disconnect(a.c);
  r.run(3000);
  assert.equal(world.people.length, 1, 'the body waits');
  assert.equal(Math.hypot(p.s.vx, p.s.vz), 0, 'and has come to rest');
  const back = r.raw(); back.send(hello('Ada', wa.token));
  const wb = welcomeOf(back);
  assert.equal(wb.id, wa.id); assert.equal(wb.horseId, wa.horseId); assert.ok(Math.abs(wb.x - p.s.x) < 1e-3 && Math.abs(wb.z - p.s.z) < 1e-3);
  assert.equal(world.people.length, 1);
  // gone for longer than the grace period: the body is removed, its horse with it, and the token is dead
  world.disconnect(back.c);
  r.run(31000);
  assert.equal(world.people.length, 0); assert.equal(world.list.length, 0);
  const late = r.raw(); late.send(hello('Ada', wa.token));
  assert.notEqual(welcomeOf(late).id, wa.id, 'ids rest before they are reused');
});

test('the same player on a second connection takes over from the first', () => {
  const world = new World({ bots: 0, now: () => 0 });
  const a = rawClient(world); a.send(hello('Ada')); const wa = welcomeOf(a);
  const b = rawClient(world); b.send(hello('Ada', wa.token));
  assert.equal(welcomeOf(b).id, wa.id); assert.ok(a.closed); assert.equal(world.people.length, 1); assert.equal(world.clients.size, 1);
});

test('sending inputs faster than time does not make a body faster, on foot or on a horse', () => {
  const r = rig();
  const a = r.raw(); a.send(hello()); const p = a.c.player; onStreet(r.world, p, 40);
  let seq = 1; const x0 = p.s.x;
  for (let i = 0; i < 100; i++) { a.send(inputs(seq, 6, 0, 127, WEST, BTN.SPRINT)); seq += 6; r.run(50); }   // 120 inputs a second for 5 s
  const d = x0 - p.s.x, fair = FOOT.sprint * 5 - 2.8;                                                        // less the run-up
  assert.ok(d > fair * 0.97 && d < fair * 1.03 + FOOT.sprint * 0.5, `covered ${d.toFixed(1)} m; an honest sprint covers ${fair.toFixed(1)} m`);
  assert.ok(r.world.totals.inputsDropped > 200, 'the surplus was thrown away');
  // the same on horseback: five seconds at 120 inputs a second from a standing start
  onStreet(r.world, p, 60); p.a.h.x = p.s.x; p.a.h.z = p.s.z; p.a.h.sp = 0; p.a.h.hx = -1; p.a.h.hz = 0; p.a.riding = 1;
  const x1 = p.a.h.x;
  for (let i = 0; i < 100; i++) { a.send(inputs(seq, 6, 0, 127, WEST, BTN.SPRINT)); seq += 6; r.run(50); }
  const tg = HORSE.gallop / HORSE.accel, dh = x1 - p.a.h.x, honest = 0.5 * HORSE.accel * tg * tg + HORSE.gallop * (5 - tg);   // building speed, then at a gallop
  assert.ok(dh > honest * 0.95 && dh < honest * 1.08 + HORSE.gallop * 0.5, `the horse covered ${dh.toFixed(1)} m; honest is ${honest.toFixed(1)} m`);
});

test('inputs that arrive in bursts still move the body evenly', () => {
  const r = rig();
  const a = r.raw(); a.send(hello()); const p = a.c.player; onStreet(r.world, p, 40);
  let seq = 1; const steps = [];
  for (let i = 0; i < 120; i++) {
    // two packets every other tick instead of one every tick
    if (i % 2) { a.send(inputs(seq, 3, 0, 127, WEST, 0)); seq += 3; a.send(inputs(seq, 3, 0, 127, WEST, 0)); seq += 3; }
    const x = p.s.x; r.run(50); if (i >= 40) steps.push(x - p.s.x);
  }
  const lo = Math.min(...steps), hi = Math.max(...steps), even = FOOT.jog / TICK_RATE;
  assert.ok(Math.abs(lo - even) < 1e-3 && Math.abs(hi - even) < 1e-3, `per-tick movement ${lo.toFixed(3)}..${hi.toFixed(3)} m, even is ${even.toFixed(3)}`);
});

test('where a body was can be asked for, between ticks too', () => {
  const r = rig();
  const a = r.raw(); a.send(hello()); const p = a.c.player, world = r.world; onStreet(world, p);
  let seq = 1; const at = [];
  for (let i = 0; i < 30; i++) { a.send(inputs(seq, 3, 0, 127, WEST, 0)); seq += 3; r.run(50); at[world.tick] = { x: p.s.x, z: p.s.z }; }
  const out = {}, t = world.tick;
  world.positionAt(p, t - 4, out); assert.ok(Math.abs(out.x - at[t - 4].x) < 1e-3);
  world.positionAt(p, t - 4.5, out); assert.ok(Math.abs(out.x - (at[t - 5].x + at[t - 4].x) / 2) < 1e-3);
  world.positionAt(p, t + 9, out); assert.ok(Math.abs(out.x - at[t].x) < 1e-3, 'the future is now');
});

test('bots live their lives for ten minutes without anyone ending up stuck in a wall or at the bottom of the river', () => {
  const world = new World({ bots: 63, now: () => 0 }), T = world.field.terrain;
  const start = world.bots.map(b => ({ x: b.e.s.x, z: b.e.s.z })); let mounts = 0, whistles = 0;
  const was = world.bots.map(b => b.e.a.riding), wh = world.bots.map(() => 0);
  for (let t = 0; t < 12000; t++) {
    world.step();
    world.bots.forEach((b, i) => { const a = b.e.a; if (a.riding !== was[i]) { mounts++; was[i] = a.riding; } if (a.whT > wh[i]) whistles++; wh[i] = a.whT; });
  }
  const moved = world.bots.map((b, i) => Math.hypot(b.e.s.x - start[i].x, b.e.s.z - start[i].z));
  const riders = world.bots.filter(b => b.role === 'rider');
  assert.ok(moved.filter(d => d > 3).length >= 55, `${moved.filter(d => d > 3).length} of 63 went somewhere`);
  assert.ok(mounts >= 10 && whistles >= 5, `riders stepped down or mounted ${mounts} times and whistled ${whistles} times`);
  assert.ok(riders.filter(b => b.e.a.riding).length >= riders.length * 0.5, 'and most riders are in the saddle at any one time');
  let swimming = 0; for (const b of world.bots) if (T.levelAt(b.e.s.x, b.e.s.z) - T.heightAt(b.e.s.x, b.e.s.z) > 1.2) swimming++;
  assert.ok(swimming <= 2, `${swimming} in deep water`);
});
