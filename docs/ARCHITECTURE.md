# Architecture, as built in Phase 2

The plan for the whole game is the Phase 1 document. This file describes what exists in the code now and why it
is shaped the way it is.

## The three parts

```
shared/   run by both sides         wire format, constants, terrain, collision, the movement step
server/   decides what is true      core/ (the world, no Node in it)   node/ (sockets and HTTP)
client/   shows it, and guesses     net/ input/ player/ render/ ui/ state/
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
   would send and goes through the same movement code.
2. Each connected player's queued inputs are applied, one 1/60 s movement step per input.
3. Every body is filed in the interest grid, its outward state is rounded to what the wire carries, and its
   position is written into a 1.6 s history (for rewinding when shots arrive, from Phase 4).
4. Each player is sent one snapshot.

The clock does not replay missed time. If the process stalls, up to four ticks are caught up; beyond 200 ms the
clock is moved instead, so a hiccup cannot snowball.

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
0.4 s and 1.3 m to stop, a 1.9 m turning arc at a sprint, a planted foot before reversing.

## Inputs: honest time, even pace

Each input is worth 1/60 s. A player earns three a tick (plus 2% so a slightly fast clock is not punished) and
can bank at most half a second. Inputs beyond that are dropped, so sending faster does not move a body faster.

Real connections deliver in bursts: nothing this tick, two packets the next. Applied as they arrive, a body would
lurch for everyone watching. So the server takes three inputs a tick and lets up to two packets wait. A deeper
queue is caught up at once; a reserve that went unused for five seconds is handed back one input at a time.

A connected player who sends nothing for half a second is stepped with empty input, so the body comes to rest
rather than freezing mid-stride. A player who drops keeps their body for 30 s and gets it back with their token.

## Interest: who is told about whom

The world is cut into 128 m squares (`server/src/core/interest.js`), the same squares terrain will stream in.
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

## The world in the tab

The page starts the server's core in a Web Worker and talks to it with the same bytes it would send over a
socket. The worker keeps the world's 20 ticks a second whatever the drawing is doing. `LagTransport` can hold
those bytes back to imitate a slow connection; the in-game ping control uses it.

## Measured (64 players, 150 ms ping, this commit)

Run on a 2-core 2.1 GHz Xeon with the 64 clients on the same machine, so the server timings are pessimistic.
Reproduce with `npm run loadtest`.

| | Everyone within 30 m | Busy town (200 m) | Scattered over the map |
|---|---|---|---|
| Server tick, median / slowest 1% | 1.6 / 3.5 ms | 1.5 / 3.4 ms | 0.9 / 2.2 ms |
| Server CPU, share of one core | 8.4% | 8.4% | 6.9% |
| Server memory | 82 MB | 84 MB | 82 MB |
| Down per player, average / worst second | 7.8 / 8.5 KB | 5.0 / 7.9 KB | 0.8 / 1.0 KB |
| Up per player | 0.56 KB/s | 0.56 KB/s | 0.56 KB/s |
| Largest snapshot | 429 bytes | 402 bytes | 70 bytes |
| Others in view, average | 63 | 63 | 2 |
| Own position, prediction against server | 0 mm, 0 corrections | 0 mm, 0 corrections | 0 mm, 0 corrections |
| Others within 60 m, drawn against truth (99th percentile) | 1.7 cm | 1.8 cm | 1.6 cm |
| Others at 60 to 150 m | | 1.9 cm | 1.9 cm |
| Others beyond 150 m | | 5.7 cm | 8.5 cm |

The budget is 50 ms a tick and 16 KB/s a player, so both have room: about 14 times on tick time and 2 times on
bandwidth in the worst case. The reports these numbers come from are in `docs/loadtest/`. A CPU profile shows nearly all the server's time is the operating system sending
and receiving packets; stepping the world and building snapshots is under 1% of a core.

**Thirty minutes.** The busy-town shape for 36,000 ticks (`--soak 1800`): the slowest 1% of ticks took 3.1 ms and
one tick took 51 ms (other jobs were running on the machine at the time). No corrections in 2.3 million
snapshots. Memory went from 82 MB to 95 MB over the first 13 minutes and then did not move for the last 17; the
heap in use stayed between 10 and 16 MB throughout, so the rise is the runtime committing heap for itself.

**600 extra bodies.** `--scenario town --bots 600 --max-players 664 --fps 20` adds 600 bots as stand-ins for NPCs
and animals, all simulated in full: 664 bodies with about 565 in view of each player. Tick median 8.0 ms, slowest
1% 14.3 ms, 20% of one core, 119 MB. Each player was sent 15.7 KB/s, the snapshot budget holding at its cap, and
players within 60 m were still drawn to within 2 cm; the shortfall landed on distant bodies. At that load most of
a tick is each player's snapshot walking and sorting its view records. If it ever matters, entities can be put in
buckets by the tick they are next due instead of sorted every tick.

Two things the numbers do not show:

- When an input reaches the server, the world that player was looking at is about 270 ms old at 150 ms ping
  (75 ms down, 100 ms of interpolation, 75 ms up, plus the input buffer). The Phase 1 plan capped lag
  compensation at 250 ms. Phase 4 should either raise that to 300 ms or draw nearby players closer to the present.
- Something that enters view while moving is drawn standing at its first known position for a fraction of a
  second before it starts to move. At 384 m this is a pixel. It will matter for things that appear close by
  (respawns, doors), and those need a spawn message that carries velocity.

## What Phase 3 replaces

`shared/world/field.js` (the test field) gives way to the baked world: region map, towns, rail. The client's
single 800 m terrain patch gives way to streamed 128 m chunks with levels of detail. The placeholder figures give
way to HoodWar's instanced characters. Nothing in `net/` or the server's tick should need to change for it.
