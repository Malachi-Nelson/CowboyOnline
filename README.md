# CowboyOnline — Calder Territory

**Play it: <https://malachi-nelson.github.io/CowboyOnline/>**

Cowboy Online is a Wild West open world for the browser, built on the bones of
[HoodWar](https://github.com/Malachi-Nelson/HoodWar): the frontier in 1899, up to 64 players in one world on an
authoritative server. Calder Territory is the world it is set in. This repository is at **Phase 4 of 11**: guns
and the law.

![A shot fired on the main street of Calder's Landing](docs/screenshots/gunfight.jpg)

| | |
|---|---|
| ![Iron Nerve: a townsman marked, the picture gone to sepia](docs/screenshots/iron-nerve.jpg) | ![Hands up, as a deputy comes to take you in](docs/screenshots/hands-up.jpg) |
| ![In the cell behind the sheriff's office](docs/screenshots/the-cell.jpg) | ![A jump at a gallop, out of town](docs/screenshots/jump.jpg) |
| ![On the main street, with your horse beside you](docs/screenshots/main-street.jpg) | ![Riding over the bridge out of town](docs/screenshots/riding-over-the-bridge.jpg) |
| ![Cold Lantern Camp in the high country](docs/screenshots/high-country.jpg) | ![The map](docs/screenshots/map.jpg) |

The pictures in `docs/screenshots/` come from a headless browser that draws in software.

## What works today

- **A territory to ride across.** Four kilometres square: Calder's Landing on the Calder river with a bridge, the
  Sawback Range and its pine forest to the north-west, the snowy high country and Cold Lantern Camp in the far
  north, the plains and Tolliver Ranch to the east, the Mirewood swamp to the south-east, and the Dry Fork desert,
  its buttes and its canyon to the south-west. Roads join the five settlements, with telegraph poles along them.
  Everything is made from one seed by plain arithmetic, so the browser and the server build the same world.
- **Your horse.** It stands beside you when you arrive. **H** whistles: it comes at a run, and if it is too far off
  to run all the way it is brought in behind you, out of sight, and runs the rest. **E** mounts and dismounts.
  It walks, trots, canters and gallops (17 m/s flat out, about 60 km/h), takes about four seconds to reach a
  gallop and two and a half to pull up, turns wider the faster it goes, will not climb a cliff, swims rivers, and
  is winded after half a minute of galloping. **Space** jumps: from a canter or a gallop it clears a fence, a
  hitching rail or a trough if you take off in the right place.
- **Guns.** A revolver and a lever-action repeater. **1** and **2** draw them, the right mouse button aims over the
  shoulder and the left fires; **R** reloads, a round at a time. Aimed and still is tight; from the hip, at a run or
  in the saddle it opens up, and every shot kicks. Head shots kill, legs make people limp. Your own browser shows
  the shot, the empty click and the reload the instant you act, and the server agrees to the bit; what a shot hit
  is decided by the server alone, against everyone as they were when you saw them (lag compensation, up to 400 ms).
- **Iron Nerve**, this game's focus mode. **Q** with the gun up: the picture goes sepia, the gun steadies, and each
  pull of the trigger marks a target. **Q** again fires at each mark in turn, as fast as the hammer comes back. It
  runs at real speed (time cannot slow for one player in a shared world) and empties a meter that refills slowly.
- **The law.** Hurt someone who did not shoot first and whoever saw it runs for the sheriff. Stop them and nobody
  hears of it; let one get there and you are wanted, with a bounty and a search circle on the map. Sheriff Garrity
  and his deputies walk the main street and come running at gunfire; they shoot on sight. Out of the circle and
  out of sight for twenty seconds, you have got away (the bounty stays on the books). Kill a lawman and a posse
  rides out after you. Hold **X** for hands up and you are taken to the cell behind the sheriff's office; die at
  the hands of the law and you wake up there.
- **A lived-in world.** Townsfolk walk the streets and scatter at gunfire; riders travel the roads, stop at the end
  of them, stretch their legs, whistle their horses back and ride on. A day lasts 48 minutes, windows light up after
  dark, and the weather comes and goes: rain on the plains, snow in the high country, mist in the Mirewood.
- **The netcode from Phase 2, now carrying horses and gunfire.** An authoritative server at 20 ticks a second,
  prediction that agrees with the server to the last bit (your horse and your guns included), interest management
  and a fixed bandwidth budget.
- **A small screen.** A round map that turns with you (lawmen, witnesses and the law's search circle on it), the
  time, rings for your health, your horse's wind and your nerve, the rounds in your gun, what the keys do right now,
  the name of a place as you ride into it, and a full map on **M**. The Phase 2 instruments are behind **F3**.

## Run it

Needs Node 22 or newer.

```sh
npm install
npm test                 # unit and end-to-end tests
npm run build            # writes client/dist/index.html, one self-contained page
npm start                # the world server on :8080 (PORT, BOTS, LAWMEN, SPAWN, ORIGINS, HOUR in the environment)
npm run loadtest         # 64 simulated players against a fresh server; add -- --quick for the 1-minute version
```

Open `client/dist/index.html` in a browser to play in the tab's own world. To join a server instead, add
`?server=ws://localhost:8080` to the address, or type the address into the title card. `?hour=21` starts the
tab's world at nine in the evening.

## How the page gets published

Every push to `main` runs the tests, builds the page and puts `client/dist/index.html` on the `gh-pages` branch
(`.github/workflows/ci.yml`). GitHub Pages serves that branch at the address above. Nothing built is kept on `main`.

`node tools/check-client.mjs` drives the built page in a headless browser: it walks away from the horse, whistles,
mounts, gallops and jumps with 150 ms of added ping, dismounts, draws, fires at a townsman, marks him in Iron Nerve
and fires the mark, and fails on any page error or prediction error. `--tour` also takes pictures around the
territory, at dusk, at night and in the rain. `node tools/check-combat.mjs` plays a whole crime through in the
page (Iron Nerve, a shot, the witnesses, hands up, the cell, out again and a jump) and takes the pictures above.
Both need Playwright, which is not in `package.json` (`npm i -D playwright && npx playwright install chromium`).

## Layout

```
shared/            code both sides run
  net/             codec.js (bytes), messages.js (every message)
  sim/             moveFoot.js, moveHorse.js, guns.js, actor.js (a player, their horse, their guns), trig.js
  world/           terrain.js, trees.js, towns.js, field.js, weather.js, collide.js, raycast.js (bullets)
server/src/core/   the authoritative world, the bots, combat.js (judging shots), law.js (witnesses, lawmen, jail);
                   no Node in it, so it also runs in a browser tab
server/src/node/   the WebSocket gateway and the /health and /status pages
client/src/        the game page
  net/             session (prediction, reconciliation, interpolation), transports, the in-tab world
  render/          scene (sky, sun, day and night), terrain and water, trees, towns, weather, figures, effects
  input/ player/   controls, camera, nerve.js (Iron Nerve)
  ui/              hud.js (the corners), map.js, page.html, style.css
  audio/           sound.js (footfalls, hoofbeats, the whistle, gunshots and their echoes, wind, water, rain, birds)
tools/             build-client.mjs, check-client.mjs, check-combat.mjs, check-two-players.mjs, loadtest/run.mjs
test/              node:test suites
docs/              ARCHITECTURE.md, PROTOCOL.md, HOSTING.md
```

The rule that keeps the two sides honest: `client/` never imports from `server/`, except `client/src/net/local.js`
and `world-worker.js`, which exist to run a whole server in the tab. `shared/` imports from neither.

## Hosting, for free

Four ways to run a world without paying, from least to most effort. Details and limits are in `docs/HOSTING.md`.

1. In the browser tab. Nothing to set up. One player and bots.
2. On your own PC, behind a Cloudflare quick tunnel. Friends join with a link. Lasts as long as your PC is on.
3. On Render's free instance. Always reachable, but small: good for a handful of players, not a full world.
4. On an Oracle Cloud Always Free machine. Enough for a full world; the most setup.

## Phases

1. Audit of HoodWar and the architecture plan. Done.
2. Server and networking foundation, load-tested with 64 clients. Done.
3. World foundation: the territory, towns, horses, day and night, weather. Done.
4. Combat, the focus meter, law and wanted levels. Done.
5. Accounts, saving, economy.
6. Bounty hunting. 7. Hunting, fishing, camp. 8. Trains and robberies. 9. The living-world pass.
10. Roles, events, posses, PvP. 11. Polish.
