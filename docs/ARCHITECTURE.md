# Architecture, as built in Phase 4

The plan for the whole game is the Phase 1 document. This file describes what exists in the code now and why it
is shaped the way it is.

## The three parts

```
shared/   run by both sides         wire format, constants, the territory, collision, movement on foot and horseback,
                                    guns, rays for bullets
server/   decides what is true      core/ (the world, its bots, combat and the law; no Node in it)   node/ (sockets and HTTP)
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
   would send and goes through the same movement code, horse, whistle and guns included. Lawmen and posse riders
   are bots too (`law.js`). A shot a bot fires is judged at once.
2. Each connected player's queued inputs are applied, one 1/60 s step per input. A step moves the player, their
   horse and their guns together (`shared/sim/actor.js`). A step that fires leaves the shot on the player, and it
   is judged right there, against the world as that player saw it (`combat.js`).
3. The dead get up again, the hurt heal, and the law takes stock: witnesses who have been on their feet long
   enough report, lawmen look for the wanted, the wanted get away or get caught (`law.js`).
4. Every body is filed in the interest grid, its outward state is rounded to what the wire carries (position,
   heading, state and gear), and its position, heading and whether it rides or lies dead are written into a 1.6 s
   history, for rewinding to judge shots.
5. Each player is sent one snapshot: their own state, their status if it changed, what happened that they could
   see, and everyone else by priority.

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

## Guns

`shared/sim/guns.js` is part of the same step as movement, under the same rules. Drawing (0.4 s), putting away,
aiming (which slows a body to a walk and steadies the gun over 0.3 s), firing (one shot each time the trigger goes
down, then the hammer or lever: 0.37 s for the revolver, 0.55 s for the repeater), reloading a round at a time
(interrupted by firing), the kick of each shot (extra spread that settles), and the Iron Nerve meter all happen in
the step. So the player's own browser shows a shot, an empty click or a reload the moment the button goes down,
and the server, stepping the same input, agrees to the bit; the load test confirms it with everyone firing.

A shot leaves on the line through the middle of the screen: the camera sits behind the player's head and to the
right (`AIM`: 1.55 m and 0.72 m on foot, 2.45 m and 0.8 m in the saddle, plus 0.15 m), and the shot starts on that
line and runs the way the view faces, nudged by the gun's spread. The spread is a disc whose size depends on the
gun, aimed or not, the speed over the ground, the saddle and recent shots; where in it the shot goes comes from a
hash of the shot count and the shooter's position, so it is the same on both sides and different every shot.

| | Revolver | Repeater |
|---|---|---|
| Rounds, spare | 6, 48 | 14, 70 |
| Between shots (Iron Nerve) | 0.37 s (0.15 s) | 0.55 s (0.27 s) |
| Reload | 0.5 s, then 0.4 s a round | 0.57 s, then 0.35 s a round |
| Damage, full to / half or more at | 34, to 25 m / 50% at 70 m | 46, to 60 m / 60% at 160 m |
| Spread aimed / from the hip | 5 / 35 mrad | 2.5 / 45 mrad |

A head shot does three times the damage (a kill with either gun), legs 0.6. 100 health; it comes back at 5 a second
from 8 s after the last hit. Dead, a player is down six seconds and then gets up on the main street with full
health and loaded guns (or, if the law killed them while wanted, in the cell).

## Judging a shot

`server/src/core/combat.js`. The shot is traced against the buildings (`BoxWorld.ray`), tree trunks below the crown
(`trees.ray`), and the ground and water (`raycast.js`) as they are now, and against every body as it was when the
shooter saw it: people as a head, a body and legs (standing, or in the saddle), horses as two boxes turned to
their heading. The first thing it meets is what was hit. A horse stops a bullet and takes no harm, for now.

"When the shooter saw it" comes with the input. Each input packet says how old the world on the shooter's screen
was (others nearby are drawn about 70 ms behind the newest snapshot). Each shot also carries a hint: who the
client's own trace put under the sights, and the moment its screen showed them there, since people further off
are drawn further in the past. The server rewinds the hinted person to their moment and everyone else to the
packet's, interpolating the 20 Hz history the same way the client interpolates snapshots.

How far back is the time from the world being as the shooter saw it to their input being stepped: the half of the
ping on the way down, how far behind others are drawn, the half on the way up, and the input buffer that smooths
uneven arrival. Measured with two players and a running target (`test/combat.test.js`): 223 ms needed at 50 ms of
ping, 326 ms at 150 ms and 360 ms at 200 ms (90th percentile). The plan said 250 ms; Phase 2 estimated 300 ms. The
cap is settled at **400 ms**, which judges everyone up to about 200 ms of ping exactly as they saw it; anyone
laggier has to lead a little. At 150 ms of ping, a man running across the street is hit 17 shots in 17 with
compensation and 3 in 17 without.

What a client cannot do: fire faster than the gun (the step enforces the hammer, and the server steps it); fire
more often than real time allows (inputs are earned at 60 a second); claim a hit (there is no such message, and an
unknown message closes the connection); shoot further into the past than 400 ms (the claim is cut back); or send
more hints than inputs. What it can do is aim well: aim assistance cannot be stopped in an open browser, which the
plan already says. Iron Nerve is aim assistance the game gives everyone, in plain sight.

## The law

`server/src/core/law.js`. A crime is hurting or killing someone who had not shot at you in the last 30 s and is not
wanted themselves; lawmen and townsfolk are never charged. Hurting and then killing the same person is charged as
the killing: $5 for hurting, $15 for killing, $10 and $35 for a lawman.

Nothing happens unless someone saw it: anyone within 55 m (70 m for a lawman) with a clear line from their eyes
to the shooter. A lawman who sees it acts at once. Townsfolk who see it become witnesses (a '!' over their heads
on every screen) and run for the sheriff's office; one who stays on their feet for ten seconds has told the law.
If every witness is stopped first, nobody hears of it.

The four lawmen of Calder's Landing (Sheriff Garrity and three deputies) walk the main street, its whole 210 m, a
few dozen paces at a time. A shot fired within 120 m of one brings him running with his gun out, to look about
where it was for 20 s; whoever is still shooting when he gets there is seen doing it. They are the town's own,
not stand-ins for players: the townsfolk and riders make room as people join, the lawmen stay however full the
world is (64 players and 4 lawmen).

Once wanted, a player has a bounty and a search circle: where the law last knew them to be, 60 m in radius
and widening by 3 m a second while they stay out of sight, up to 160 m. The lawmen go there, search it, and shoot
on sight, from 16 to 24 m if they can, with an aim that worsens with range, the target's speed and the saddle.
Out of the circle and unseen for 20 s, or unseen anywhere for 75 s, the player has got away; the bounty stays on
the books for the bounty hunters of Phase 6. Killing a lawman, or a bounty of $40 or more, sends a posse: three
riders brought in about 150 m away on dry ground, riding the player down and shooting from the saddle; they ride
off when the player is no longer wanted. At most twelve ride at once; past that nobody new is sent, and those
riding take on the nearest wanted player once their own is dealt with.

Hands up (X, gun put away, feet on the ground) where a lawman can see it brings him over; 1.5 s within 2.6 m and
the player is arrested. Arrested, or killed by the law while wanted, the player is put in the barred cell behind
the sheriff's office for 10 s plus half a second a dollar (at most a minute), unable to draw, then let out at the
office door with the slate wiped. There is no money yet (Phase 5), so time is the price.

## Iron Nerve

The focus mode the plan asked for, named for this game. Q while aiming, with some meter left: the picture turns
sepia with a dark vignette, the view narrows, the world's sounds drop behind a heartbeat, the gun's spread falls to
almost nothing, and the hammer is quicker. Each pull of the trigger then marks whoever is under the sights instead
of firing (not through walls, at most one mark a round). Q again, the meter running dry, or a mark for every round
fires the marks in turn: the client turns the view to each mark and pulls the trigger as soon as the hammer is back.
Seven seconds of meter, refilling over 45 s.

All of that is client-side presentation over ordinary inputs: the server sees the view turn and the trigger pulled
with the focus button held, and enforces the focus fire rate and the meter itself (they are in the shared step).
Upgrades to the meter need ranks, which arrive with Phase 5.

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
  The curve ramps before each range boundary so nothing jumps back in time when it crosses one. A rider is drawn
  on their horse at the horse's moment, and their own updates (which way they aim, what is in their hand) are
  read at that moment too. Something put somewhere new (by the server, by a whistle, out of the saddle) is shown
  there at once, with nothing drawn between.

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

## Measured (64 players, 150 ms ping, Phase 4)

Run on a 2-core 2.1 GHz Xeon with the 64 clients on the same machine, so the server timings are pessimistic.
Every simulated player has a horse; two in three of them whistle for it, ride, and get down now and then. In the
gunfight each also has a gun out and, every few seconds, aims at whoever is nearest on their own screen, holds the
aim a moment and fires; the sheriff and his deputies are in town, and posses ride. Reproduce with
`npm run loadtest`.

| | Everyone within 30 m | In and around town | Scattered over the map | Gunfight in the street |
|---|---|---|---|---|
| Server tick, median / slowest 1% | 2.1 / 5.8 ms | 2.5 / 6.9 ms | 1.3 / 3.6 ms | 2.8 / 7.3 ms |
| Server CPU, share of one core | 10.3% | 11.3% | 9.2% | 12.7% |
| Server memory | 113 MB | 115 MB | 104 MB | 119 MB |
| Down per player, average / worst second | 9.0 / 10.2 KB | 6.5 / 8.4 KB | 1.3 / 2.0 KB | 8.5 / 10.6 KB |
| Up per player | 0.76 KB/s | 0.76 KB/s | 0.76 KB/s | 0.76 KB/s |
| Largest snapshot | 522 bytes | 463 bytes | 137 bytes | 692 bytes |
| Others in view, average (people and horses) | 126 | 126 | 4.5 | 142 |
| Own position, prediction against server | 0 mm, 0 corrections | 0 mm, 0 corrections | 0 mm, 0 corrections | exact in 99.6% of snapshots |
| Others within 60 m, drawn against truth (99th percentile) | 1.8 cm | 1.8 cm | 1.8 cm | 1.9 cm |
| Others at 60 to 150 m | 5.4 cm | 2.3 cm | 2.0 cm | 2.2 cm |
| Others beyond 150 m | | 7.3 cm | 17 cm | see below |

In the gunfight's minute: 954 shots, 617 hits and 175 deaths; shots were judged 307 ms in the past on average and
399 ms at most, and 1 was cut back to the 400 ms cap; 125,857 shots, hits and deaths were told to the players
who could see them, none dropped for want of room. The same script run again cut back 290 shots of 929, judged
339 ms back on average: the simulated connections have 20 ms of jitter each way, and 64 clients sharing two cores
with the server draw their frames late now and then, which ages what they saw. So at 150 ms of ping the cap has
little room. Raising it to 500 ms is one constant (`REWIND_MAX`), at the cost of being hit a little longer after
reaching cover. 278 crimes: 127 seen by a lawman, the rest unseen (there are no
townsfolk in this test to witness them); 4 posses rode out, reaching the cap of 12 riders; 4 players were killed by
the law and woke up in the cell. The 323 corrections of a player's own position are the 175 deaths and the
risings after them, which no client can predict.

Against Phase 3 the server costs about a fifth more (guns and the law in every step), each player sends a third more (pitch and wider buttons
in every input) and is sent much the same. The budget is 50 ms a tick and 16 KB/s a player. The report is
`docs/loadtest/phase4-64-players.json`; earlier phases' reports are beside it. Beyond 150 m a galloping horse is
updated five times a second and moves 3.4 m between updates, which is where the 17 cm comes from; at that range it
is under a pixel. Beyond 150 m in the gunfight there are only the people in the cell, 60 samples in all, and one
of them was drawn 13 m from where it was; a second run of the gunfight (87 samples) had none worse than 9 cm. That
one has not been explained.

The moments around something being put somewhere (getting up, the cell, out of the saddle, a horse brought in by
a whistle) are left out of the "drawn against truth" figures: there is no path between the two places to measure
against, and a viewer shows the new place as soon as it hears of it.

**From Phase 2, still true.** A 30-minute soak held memory flat after the runtime had committed its heap, and 600
extra bots (stand-ins for NPCs and animals) kept the slowest 1% of ticks at 14 ms with the snapshot budget
holding at its cap. Those runs have not been repeated on the Phase 4 world.

One thing the numbers do not show: something that enters view while moving is drawn standing at its first known
position for a fraction of a second before it starts to move. At 384 m this is a pixel; a spawn message that
carries velocity would fix it for things that appear close by.

## Not measured

- **Frame rate on real hardware.** The checks here run in a software renderer at a few frames a second, so all
  they can count is draw calls and triangles. The target is 60 frames a second on a mid-range laptop. The parts
  that threaten it, in order: the outer terrain rings (about 100,000 triangles together), dense forest within
  760 m (up to about 15,000 trees in view, a few triangles each), and the town meshes when standing in Calder's
  Landing (23,000 triangles). Each has a knob: ring size, tree radius and thinning, and town detail. A gunfight
  adds three draw calls however many are firing (one particle system, one set of tracer lines, one set of bullet
  holes), and the guns in everyone's hands are instanced with the figures.
- **How a gunfight feels.** Spread, kick, damage, the time it takes to drop someone, the reticle, hit reactions and
  Iron Nerve are numbers held in place by tests. Whether they feel right needs someone playing with a mouse.
- **The lawmen's judgment.** Each thing they do (see, run to gunfire, search, shoot, close in on hands up, give
  up, ride in a posse) has a test. Whether they are fair and fun to be chased by has not been judged by a person.
  Known rough edge: they can be slow to finish someone who is down to a sliver of health.
- **Firefox and Safari.** Determinism of the territory, movement and guns is proven in V8 (Node and Chromium).
- **Sound.** Gunshots, the click of an empty gun, reloads, ricochets, hits and the Iron Nerve heartbeat are made in
  code, like the rest, and checked only in that they play without errors; nobody has listened to them yet.

## Where Phase 4 differs from the plan

- **Shots are judged up to 400 ms back, not 250 ms.** Measured above ("Judging a shot"): 326 ms is what 150 ms of
  ping needs. With 250 ms, anyone past about 50 ms of ping would have had to lead every target.
- **Iron Nerve has a meter but no upgrades yet.** Upgrades need ranks and money, which arrive in Phase 5.
- **The cell instead of a fine.** There is no money until Phase 5, so a bounty is paid in time: ten seconds and
  half a second a dollar, at most a minute. Bounties stay on the books for Phase 6.
- **Horses stop bullets and take no harm.** A shot that meets a horse is stopped by it; a horse that can be hurt,
  bleed and die belongs with horse care, which the plan does not place yet.
- **Only death takes a rider out of the saddle.** Being hit makes the figure flinch; it does not unseat.
- **Two guns.** A revolver and a repeater. More would come with something to buy them with (Phase 5); a new gun
  is one more row in the table in `guns.js`.
- **Lawmen in one town.** The sheriff and three deputies are in Calder's Landing; the four smaller places have
  none yet. Posses ride anywhere.
- **Anyone can shoot anyone.** The crime rules (self-defence, the wanted are fair game) are all that governs it.
  The plan's opt-in rules for player against player are Phase 10.
- **No lasso, no fists, no looting.** Bodies of townsfolk lie for a minute; players get up after six seconds.
