// The authoritative world: who may join, what each player is told, and what a player cannot get away with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, rawClient } from './helpers.js';
import { World } from '../server/src/core/world.js';
import { Writer, Reader } from '../shared/net/codec.js';
import { MSG, REJECT, UM, encHello, encInputHead, encCmd, decWelcome, readSnapshot } from '../shared/net/messages.js';
import { SNAPSHOT_BUDGET, HUB_X, HUB_Z, VIEW_ENTER, VIEW_LEAVE, PROTOCOL_VERSION, TICK_RATE } from '../shared/constants.js';
import { FOOT, BTN } from '../shared/sim/moveFoot.js';

const w = new Writer(256);
const hello = (name = 'Tester', token = '') => encHello(w, name, token);
const inputs = (first, n, mx, mz, yaw, buttons) => { encInputHead(w, first, n, 0); for (let i = 0; i < n; i++) encCmd(w, mx, mz, yaw, buttons); return w.bytes(); };
const WEST = 16384;                          // a quarter turn left of north: open, level ground from the hub
const welcomeOf = raw => { const i = raw.types().indexOf(MSG.WELCOME); assert.ok(i >= 0, 'welcomed'); return decWelcome(raw.reader(i)); };

test('a newcomer is welcomed, and the bots make room', () => {
  const world = new World({ bots: 63, now: () => 0 });
  assert.equal(world.list.length, 63);
  const a = rawClient(world); a.send(hello('Ada'));
  const wa = welcomeOf(a);
  assert.equal(wa.proto, PROTOCOL_VERSION); assert.equal(wa.tickRate, TICK_RATE); assert.equal(wa.token.length, 24);
  assert.ok(Math.hypot(wa.x - HUB_X, wa.z - HUB_Z) <= 12.5, 'spawned at the hub');
  assert.equal(world.bots.length, 63); assert.equal(world.list.length, 64);
  const b = rawClient(world); b.send(hello('Boone'));
  assert.equal(world.bots.length, 62); assert.equal(world.people.length, 2); assert.equal(world.list.length, 64);
  assert.notEqual(welcomeOf(b).id, wa.id);
});

test('an old client, a full world and a nonsense message are all turned away', () => {
  const world = new World({ bots: 0, maxPlayers: 2, now: () => 0 });
  const old = rawClient(world); w.reset(); w.u8(MSG.HELLO); w.u16(PROTOCOL_VERSION + 1); w.str('Old'); w.str(''); old.send(w.bytes());
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

test('a connection that floods is closed', () => {
  const world = new World({ bots: 0, now: () => 0 });
  const a = rawClient(world); a.send(hello());
  for (let i = 0; i < 300 && !a.closed; i++) a.send(inputs(1 + i * 3, 3, 0, 0, 0, 0));
  assert.ok(a.closed);
});

test('every snapshot fits the budget and the client ends up with exactly what the server thinks it has', () => {
  // the worst case for one player: 63 bots milling about within 30 m
  const world = new World({ bots: 63, roam: 30, now: () => 0 });
  const a = rawClient(world); a.send(hello());
  const mirror = new Map(); let biggest = 0, updates = 0, holds = 0;
  const h = {
    self() {}, despawn: id => { assert.ok(mirror.delete(id), 'only known entities are despawned'); },
    spawn: (t, id, kind, ef, name, qx, qy, qz, yaw, st) => { assert.ok(!mirror.has(id), 'no entity is spawned twice'); mirror.set(id, { qx, qy, qz, yaw, st }); },
    update: (t, id, mask, hold, dx, dy, dz, yaw, st) => {
      const m = mirror.get(id); assert.ok(m, 'no update for an entity that was never spawned'); updates++; if (mask & UM.HOLD) holds++;
      m.qx += dx; m.qy += dy; m.qz += dz; if (yaw >= 0) m.yaw = yaw; if (st >= 0) m.st = st;
    },
  };
  let seq = 1;
  for (let t = 0; t < 1200; t++) {
    a.send(inputs(seq, 3, 0, 127, (t * 40) & 65535, BTN.SPRINT)); seq += 3;
    world.step();
    for (const b of a.got.splice(0)) {
      if (b[0] !== MSG.SNAPSHOT) continue;
      assert.ok(b.length <= SNAPSHOT_BUDGET, `snapshot of ${b.length} bytes`); if (b.length > biggest) biggest = b.length;
      const r = new Reader(b); r.u8(); readSnapshot(r, h); assert.equal(r.left, 0);
    }
  }
  assert.equal(mirror.size, 63, 'all 63 are in view');
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
  const ev = []; const h = { self() {}, despawn: id => ev.push('gone ' + id), spawn: (t, id) => ev.push('spawn ' + id), update() {} };
  for (const m of a.got) if (m[0] === MSG.SNAPSHOT) { const r = new Reader(m); r.u8(); readSnapshot(r, h); }
  assert.deepEqual(ev, [`spawn ${pb.id}`, `gone ${pb.id}`, `spawn ${pb.id}`]);
});

test('a player nobody can see costs nothing', () => {
  const world = new World({ bots: 63, spawn: 'spread', now: () => 0 });
  const a = rawClient(world); a.send(hello());
  // spread worlds scatter people too; walk nowhere and count what arrives
  for (let i = 0; i < 400; i++) world.step();
  const sizes = a.got.filter(b => b[0] === MSG.SNAPSHOT).map(b => b.length);
  assert.ok(a.c.view.size <= 8, `few neighbours (${a.c.view.size})`);
  const median = sizes.sort((p, q) => p - q)[sizes.length >> 1];
  assert.ok(median <= 60, `median snapshot ${median} bytes`);
});

test('dropping and coming back within the grace period keeps the same body', () => {
  const r = rig();
  const world = r.world, a = r.raw(); a.send(hello('Ada'));
  const wa = welcomeOf(a), p = a.c.player;
  let seq = 1; for (let i = 0; i < 40; i++) { a.send(inputs(seq, 3, 0, 127, 0, BTN.SPRINT)); seq += 3; r.run(50); }
  const moved = Math.hypot(p.s.x - wa.x, p.s.z - wa.z); assert.ok(moved > 8, `ran ${moved.toFixed(1)} m`);
  world.disconnect(a.c);
  r.run(3000);
  assert.equal(world.people.length, 1, 'the body waits');
  assert.equal(Math.hypot(p.s.vx, p.s.vz), 0, 'and has come to rest');
  const back = r.raw(); back.send(hello('Ada', wa.token));
  const wb = welcomeOf(back);
  assert.equal(wb.id, wa.id); assert.ok(Math.abs(wb.x - p.s.x) < 1e-3 && Math.abs(wb.z - p.s.z) < 1e-3);
  assert.equal(world.people.length, 1);
  // gone for longer than the grace period: the body is removed and the token is dead
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

test('sending inputs faster than time does not make a body faster', () => {
  const r = rig();
  const a = r.raw(); a.send(hello()); const p = a.c.player, x0 = p.s.x, z0 = p.s.z;
  let seq = 1;
  for (let i = 0; i < 100; i++) { a.send(inputs(seq, 6, 0, 127, WEST, BTN.SPRINT)); seq += 6; r.run(50); }   // 120 inputs a second for 5 s
  const d = Math.hypot(p.s.x - x0, p.s.z - z0), fair = FOOT.sprint * 5 - 2.8;                                // less the run-up
  assert.ok(d > fair * 0.97 && d < fair * 1.03 + FOOT.sprint * 0.5, `covered ${d.toFixed(1)} m; an honest sprint covers ${fair.toFixed(1)} m`);
  assert.ok(r.world.totals.inputsDropped > 200, 'the surplus was thrown away');
});

test('inputs that arrive in bursts still move the body evenly', () => {
  const r = rig();
  const a = r.raw(); a.send(hello()); const p = a.c.player;
  let seq = 1; const steps = [];
  for (let i = 0; i < 120; i++) {
    // two packets every other tick instead of one every tick
    if (i % 2) { a.send(inputs(seq, 3, 0, 127, WEST, 0)); seq += 3; a.send(inputs(seq, 3, 0, 127, WEST, 0)); seq += 3; }
    const x = p.s.x; r.run(50); if (i >= 40) steps.push(x - p.s.x);
  }
  const lo = Math.min(...steps), hi = Math.max(...steps), even = FOOT.jog / TICK_RATE;
  assert.ok(Math.abs(lo - even) < 1e-6 && Math.abs(hi - even) < 1e-6, `per-tick movement ${lo.toFixed(3)}..${hi.toFixed(3)} m, even is ${even.toFixed(3)}`);
});

test('where a body was can be asked for, between ticks too', () => {
  const r = rig();
  const a = r.raw(); a.send(hello()); const p = a.c.player, world = r.world;
  let seq = 1; const at = [];
  for (let i = 0; i < 30; i++) { a.send(inputs(seq, 3, 0, 127, 0, 0)); seq += 3; r.run(50); at[world.tick] = { x: p.s.x, z: p.s.z }; }
  const out = {}, t = world.tick;
  world.positionAt(p, t - 4, out); assert.ok(Math.abs(out.z - at[t - 4].z) < 1e-3);
  world.positionAt(p, t - 4.5, out); assert.ok(Math.abs(out.z - (at[t - 5].z + at[t - 4].z) / 2) < 1e-3);
  world.positionAt(p, t + 9, out); assert.ok(Math.abs(out.z - at[t].z) < 1e-3, 'the future is now');
});
