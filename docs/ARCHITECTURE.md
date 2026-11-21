# Architecture, as built in Phase 3

The plan for the whole game is the Phase 1 document. This file describes what exists in the code now and why it
is shaped the way it is.

## The three parts

```
shared/   run by both sides         wire format, constants, the territory, collision, movement on foot and horseback
server/   decides what is true      core/ (the world and its bots, no Node in it)   node/ (sockets and HTTP)
client/   shows it, and guesses     net/ input/ player/ render/ ui/ audio/ state/
```

`shared/` imports from neither side. `server/` imports only `shared/`. `client/` imports only `shared/`, with one
exception that is the point of it: `client/src/net/local.js` and `world-worker.js` load the server's core so a
complete world can run inside the browser tab.

Each system is one module with a small surface. The client has one shared store (`state/store.js`) for what the
player's own machine decides: settings, which screen is up. Everything about the world comes from the session,
and the server decides that.

## One tick on the server

`server/src/core/world.js`, 20 times a second:

1. Bots think and are stepped. A bot is a player without a socket: it fills in the same input record a browser
   would send and goes through the same movement code, horse and whistle included.
2. Each connected player's queued inputs are applied, one 1/60 s step per input. A step moves the player and
   their horse together (`shared/sim/actor.js`).
3. Every body is filed in the interest grid, its outward state is rounded to what the wire carries, and its
   position is written into a 1.6 s history (for rewinding when shots arrive, from Phase 4).
4. Each player is sent one snapshot.

The clock does not replay missed time. If the process stalls, up to four ticks are caught up; beyond 200 ms the
clock is moved instead, so a hiccup cannot snowball.

## The territory

`shared/world/` builds the whole map from one seed, the same way in the browser and on the server, in about
three quarters of a second. Nothing is downloaded and nothing is baked into files: the world is arithmetic.

- **Ground** (`terrain.js`). Heights on a 4 m lattice, 1,025 points a side, read bilinearly. Each spot is a blend
  of regions (high country to the north, the Sawback Range to the north-west, desert to the south-west, the
  Mirewood to the south-east, plains everywhere else) whose borders are bent by slow noise. Then, in order: the
  river is cut along a smooth curve with a water level that only ever falls, banks that open out and never leave
  land lower than the water beside it, and a knee-deep ford; the five settlements get level pads; a dry canyon
  is cut through the desert; and the roads are levelled across their width with the worst gradients cut out of
  the hills. Water is a second lattice: the river's level along its course, and the Mirewood's standing water.
- **Trees** (`trees.js`). One byte for every 8 m square: which kind stands there and how big. Where in the square
  comes from a hash. 63,000 trees, and the server collides bodies with their trunks.
- **Towns** (`towns.js`). Every building, porch, post, rail, trough, lamp, wagon, the bridge and the telegraph line
  along the roads is described once. The server takes solid boxes from those descriptions; the browser draws from
  the same records. Solids are axis-aligned boxes, so every street runs north-south or east-west.
- **Weather** (`weather.js`). Not sent: worked out from the world's clock and position, so everyone in a world sees
  the same front cross the same hill.

Everything here keeps to the rule movement keeps (below): only `+ - * /` and `Math.sqrt`, so every engine builds
the same ground. Tests pin a handful of heights and a checksum of the forest.

## A player is a body and a horse

`shared/sim/actor.js` is the one function that moves a player: their body on foot (`moveFoot.js`), their horse
(`moveHorse.js`), and which of the two the controls are driving.

- **Whistling** sets the horse running to its owner at a gallop, a canter or a trot depending on distance, and it
  pulls up beside them. From more than 85 m away it is first put somewhere nearer: 55 m off, behind the way the
  owner is looking, on dry and gentle ground with nothing built and no deep water between it and them. If it
  stops making progress (a river, a wall), it is put nearer again.
- **Mounting** needs the horse within 2.6 m and slower than a trot. Stepping down puts the rider on the horse's
  near side, or the far side if that is blocked (by a wall, a bridge rail, or a drop), keeping some of its speed.
- **Jumping** (Space while riding) happens on the key going down, from the ground, going forward, with wind to
  spare and out of deep water. From a canter or a gallop the horse leaves the ground at 7 m/s and rises about
  1.2 m: anything whose top is below its hooves plus a step (a fence, a hitching rail, a trough, a low wall up
  to about 1.4 m, taken in the right place) stops counting as an obstacle while it is over it. From a walk or a
  trot it is a hop. In the air it holds its speed and heading. Landing costs a little speed, more after a long
  drop or into a rise, so hopping up a hill is no quicker than running up it; a jump never carries a horse up a
  bank, and it cannot take off from ground too steep to climb.
- **Riding** steers like a horse, not a car: the stick says where to go as seen from the camera and the horse
  comes round to it at a rate that falls with speed, slowing first if asked to turn back on itself. Pulling
  straight back reins it in, then backs it up. Two circles, fore and hind, collide with the world.

Because all of this happens inside the step, the player's own browser predicts it like any other movement: the
horse turns and runs the moment the key goes down, and the server agrees to the last bit. So the horse is part
of the player's own state on the wire, sent in full precision whenever it changes. Everyone else sees it as an
ordinary entity that names its owner, and draws the owner sitting on it.

The feel numbers are constants at the top of `moveHorse.js`, pinned by tests: gaits of 1.7, 4.2, 8.5 and
17 m/s; 4.25 s from standing to a gallop, 2.5 s and 21 m to rein in, a turning radius of 1.7 m at a walk,
8.6 m at a canter and 20.7 m at a gallop, about 32 s of gallop before the horse is winded, a third of the speed
lost on a 20 degree climb, nothing above 38 degrees, swimming at 2.4 m/s, and a jump 1.17 m high, 5.8 m long
from a canter and 11.6 m from a gallop, costing a twentieth of the horse's wind.

## Movement, and why client and server never disagree

`shared/sim/moveFoot.js` is one fixed step. The browser runs it the moment a key goes down; the server runs it
when the input arrives. Two rules make both land on exactly the same numbers:

- The step uses only `+ - * /` and `Math.sqrt`. Every JavaScript engine hands those straight to the processor,
  which rounds them one way only; `Math.sin` and friends are computed by each engine's own code and differ in the
  last bit between browsers. Directions come from a table built with plain arithmetic (`shared/sim/trig.js`).
  The terrain height function follows the same rule. This has been run in Node and Chromium (both V8); Firefox
  and Safari are expected to agree and have not been run yet.
- State is rounded to 32-bit floats at the end of every step, and a snapshot carries those same 32-bit values.
  So when the server corrects a client, the client then holds precisely what the server holds.

In the 64-player load test the largest disagreement over 230,400 snapshots was 0 mm, with 0 corrections.
Corrections still exist for the cases that deserve them: the server stopping a body whose owner went quiet,
inputs thrown away for arriving faster than time, and from Phase 4, being hit.

The feel numbers are constants at the top of `moveFoot.js`, pinned by tests: 0.87 s from standing to a sprint,
0.4 s and 1.3 m to stop, a 1.9 m turning arc at a sprint, a planted foot before reversing. Since Phase 3 a body
also slows in water over its shins, floats and swims at chest depth, slows uphill by the slope it is actually
on, and cannot climb ground steeper than about 48 degrees, jumping or not.

## Inputs: honest time, even pace

Each input is worth 1/60 s. A player earns three a tick (plus 2% so a slightly fast clock is not punished) and
can bank at most half a second. Inputs beyond that are dropped, so sending faster does not move a body faster.

Real connections deliver in bursts: nothing this tick, two packets the next. Applied as they arrive, a body would
lurch for everyone watching. So the server takes three inputs a tick and lets up to two packets wait. A deeper
queue is caught up at once; a reserve that went unused for five seconds is handed back one input at a time.

A connected player who sends nothing for half a second is stepped with empty input, so the body comes to rest
rather than freezing mid-stride. A player who drops keeps their body for 30 s and gets it back with their token.

## Interest: who is told about whom

The world is cut into 128 m squares (`server/src/core/interest.js`).
Four times a second each player's view is rebuilt from the squares around them: anything within 384 m comes in,
anything past 448 m goes out. The gap stops things flickering at the edge. The cost of finding neighbours does
not grow with the size of the world.

## Snapshots: a fixed budget, spent by priority

Each player gets at most 796 bytes a tick. In order: their own exact state, who left their view, who arrived
(nearest first, using at most 60% of what is left), then updates. Every entity in view earns priority each tick,
faster the nearer it is, and whatever has earned a full point and has changed is written, most overdue first,
until the budget is spent. The rest keep their priority. Under pressure this degrades by distance, never by
dropping someone entirely. Layouts are in `PROTOCOL.md`.

## The client session

`client/src/net/session.js` has no browser in it, which is how the load test can run 64 of them in Node.

- **Prediction.** Every 1/60 s: sample the controls, round them to what the wire carries, step the body, remember
  the result, send every third.
- **Reconciliation.** Each snapshot names the last input applied and the state after it. If that differs from
  what was predicted for the same input, the body is put where the server says, the inputs since are run again,
  and the view glides to the new place over a tenth of a second.
- **Everyone else.** Drawn in the past, sliding between received positions. How far in the past is per entity:
  100 ms within 60 m, more for things that are updated less often, plus whatever the connection's jitter needs.
  The curve ramps before each range boundary so nothing jumps back in time when it crosses one.

## Drawing the territory

The browser draws from the same field the server uses, so there is nothing to download but the page.

- **Ground**: four square rings of mesh centred on the viewer, at 4, 8, 16 and 32 m between points, out to 2 km;
  each coarser ring has a hole where the finer one sits, and a skirt hides the seams. A ring is rebuilt when the
  viewer has moved two of its cells, at most one ring a frame. The ground's colour (grass, forest floor, sand,
  banded rock, mud, snow, road, shingle) is painted once per lattice point and kept; the map is the same paint.
- **Water**: one ribbon down the river following its fall, foamy where it drops, and one sheet at swamp level
  that runs out past the edge of the map. The land hides it wherever it is higher.
- **Trees**: one instanced mesh per kind near the viewer (within 165 m) and two low models beyond, out to 760 m,
  thinned to every other tree past 420 m. Rebuilt every 32 m of travel. They sway.
- **Towns**: one mesh for every wall, roof and post, one for the glass (it lights up after dark), one for the
  signs (all painted onto one canvas), one for the telegraph wires.
- **People and horses**: one instanced mesh per body part. Horses change gait by speed with each leg on its own
  timing (walk, trot, canter, gallop), pitch over rough ground, nod and swish their tails; riders sit them.
- **Sky**: the light follows the world's clock, from a table of colours by hour, with a sun and moon, stars, and
  an overcast that greys the sky and takes the shadows away. Rain and snow fall in a box that travels with the
  camera, positioned entirely on the graphics card.

On the main street in daylight this is 27 draw calls and about 220,000 triangles a frame. That is measured in a
software renderer, which cannot say anything about frame rate on real hardware; see "Not measured" below.

## The world in the tab

The page starts the server's core in a Web Worker and talks to it with the same bytes it would send over a
socket. The worker keeps the world's 20 ticks a second whatever the drawing is doing. `LagTransport` can hold
those bytes back to imitate a slow connection; the in-game ping control uses it.

## Measured (64 players, 150 ms ping, Phase 3)

Run on a 2-core 2.1 GHz Xeon with the 64 clients on the same machine, so the server timings are pessimistic.
Every simulated player has a horse; two in three of them whistle for it, ride, and get down now and then.
Reproduce with `npm run loadtest`.

| | Everyone within 30 m | In and around town | Scattered over the map |
|---|---|---|---|
| Server tick, median / slowest 1% | 1.8 / 4.4 ms | 1.9 / 3.7 ms | 1.0 / 2.7 ms |
| Server CPU, share of one core | 8.9% | 9.2% | 7.4% |
| Server memory | 111 MB | 110 MB | 101 MB |
| Down per player, average / worst second | 8.7 / 9.9 KB | 6.4 / 9.1 KB | 1.3 / 1.9 KB |
| Up per player | 0.56 KB/s | 0.56 KB/s | 0.56 KB/s |
| Largest snapshot | 510 bytes | 465 bytes | 154 bytes |
| Others in view, average (people and horses) | 126 | 126 | 4.6 |
| Own position, prediction against server | 0 mm, 0 corrections | 0 mm, 0 corrections | 0 mm, 0 corrections |
| Others within 60 m, drawn against truth (99th percentile) | 1.9 cm | 2.0 cm | 1.9 cm |
| Others at 60 to 150 m | 2.2 cm | 3.3 cm | 2.1 cm |
| Others beyond 150 m | | 7.4 cm | 19.3 cm |

Against Phase 2 the server costs about the same (the territory adds memory, not time: about 22 MB once built), and
each player is sent about 10% more, because there are now twice as many things to tell them about. The budget is
50 ms a tick and 16 KB/s a player. The report is `docs/loadtest/phase3-64-players.json`; the Phase 2 reports are
beside it. Beyond 150 m a galloping horse is updated five times a second and moves 2.6 m between updates, which
is where the 19 cm comes from; at that range it is under a pixel.

**From Phase 2, still true.** A 30-minute soak held memory flat after the runtime had committed its heap, and 600
extra bots (stand-ins for NPCs and animals) kept the slowest 1% of ticks at 14 ms with the snapshot budget
holding at its cap. Those runs have not been repeated on the Phase 3 world.

Two things the numbers do not show:

- When an input reaches the server, the world that player was looking at is about 270 ms old at 150 ms ping
  (75 ms down, 100 ms of interpolation, 75 ms up, plus the input buffer). The Phase 1 plan capped lag
  compensation at 250 ms. Phase 4 should either raise that to 300 ms or draw nearby players closer to the present.
- Something that enters view while moving is drawn standing at its first known position for a fraction of a
  second before it starts to move. At 384 m this is a pixel. It will matter for things that appear close by
  (respawns, doors), and those need a spawn message that carries velocity.

## Not measured

- **Frame rate on real hardware.** The checks here run in a software renderer at a few frames a second, so all
  they can count is draw calls and triangles. The target is 60 frames a second on a mid-range laptop. The parts
  that threaten it, in order: the outer terrain rings (about 100,000 triangles together), dense forest within
  760 m (up to about 15,000 trees in view, a few triangles each), and the town meshes when standing in Calder's
  Landing (23,000 triangles). Each has a knob: ring size, tree radius and thinning, and town detail.
- **Firefox and Safari.** Determinism of the territory and of movement is proven in V8 (Node and Chromium).
- **Sound.** Made in code and checked only in that it plays without errors; nobody has listened to it yet.

## Where Phase 3 differs from the plan

- The territory is generated from a seed by arithmetic at start-up, not loaded from baked height files. The
  whole lattice is 4 MB, so nothing needs streaming from a server; the rings stream the drawing instead.
- The terrain lattice is 4 m, not the plan's 2 m. 2 m would quadruple memory and build time for detail the
  camera mostly does not see; roads, pads and the river are shaped to suit 4 m.
- The rail line is not in yet. It needs a gentler grade than the roads and cuts, embankments and a second bridge;
  it is planned for Phase 8, with the trains.
- People and horses are box figures made here, not HoodWar's characters, which have no horses or riding poses to
  carry over.
- Weather is not regional in the sense of separate weather per region: one pattern of fronts drifts across the
  whole map, and each region turns it into its own weather (rain, snow, little in the desert).
