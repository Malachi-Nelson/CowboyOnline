// The game page. It owns the frame loop and wires the pieces together; each piece is its own module:
//   net/        the session (prediction, reconciliation, interpolation) and the ways to reach a world
//   input/      keyboard, mouse and touch, turned into intent
//   player/     the camera
//   render/     sky and light, terrain and water, trees, towns, weather, people and horses
//   audio/      every sound, made on the spot
//   ui/         the corners of the screen, the map, the title card
//   state/      the one shared store
import { createStore, saved } from './state/store.js';
import { createScene } from './render/scene.js';
import { createTerrain, createWater } from './render/terrain.js';
import { createTrees } from './render/trees.js';
import { createTowns } from './render/towns.js';
import { createWeather } from './render/weather.js';
import { createFigures } from './render/figures.js';
import { createCamera } from './player/camera.js';
import { createControls } from './input/controls.js';
import { createHud } from './ui/hud.js';
import { makeMapImage, createMap } from './ui/map.js';
import { createSound } from './audio/sound.js';
import { Session } from './net/session.js';
import { WsTransport, LagTransport } from './net/transport.js';
import { LocalTransport } from './net/local.js';
import { makeField } from '../../shared/world/field.js';
import { weatherAt } from '../../shared/world/weather.js';
import { HUB_X, HUB_Z, EF_BOT, KIND_HORSE, ST_RIDING, WORLD_SEED, TICK_MS } from '../../shared/constants.js';
import { horseNear } from '../../shared/sim/moveHorse.js';

const $ = id => document.getElementById(id);
const app = $('app'), canvas = $('view'), status = $('status');
const hosted = app.dataset.host === 'artifact';          // inside a preview page that cannot open sockets
const coarse = matchMedia('(pointer: coarse)').matches, still = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (coarse) document.documentElement.classList.add('touch');
const params = new URLSearchParams(location.search), preset = params.get('server') || '';
const startHour = params.has('hour') ? Math.max(0, Math.min(23.99, +params.get('hour') || 0)) : undefined;

const store = createStore({ mode: 'menu', showStats: false, lag: 0, bandTint: false, grid: false, locked: false });
const view = createScene(canvas), controls = createControls(canvas, store), hud = createHud(store), sound = createSound();
const LAGS = [0, 150, 300];
// before the world is built: just the sky
const fallbackCam = new globalThis.THREE.PerspectiveCamera(58, 1, 0.3, 3000); fallbackCam.position.set(HUB_X, 60, HUB_Z + 60); fallbackCam.lookAt(HUB_X, 40, HUB_Z);
let session = null, lagT = null, inner = null, local = null;       // local: the world in this tab, when that is what we are in
let field = null, world = null, figures = null, camera = null, map = null, seedBuilt = -1, building = false;

// everything drawn that comes from the world's seed: built once, when the first welcome says which world this is
function buildWorld(f) {
  if (world) for (const k of ['terrain', 'water', 'trees', 'towns', 'weather']) world[k].dispose();
  const t0 = performance.now(), terrain = createTerrain(view.scene, f, view.env);
  world = { terrain, water: createWater(view.scene, f), trees: createTrees(view.scene, f), towns: createTowns(view.scene, f), weather: createWeather(view.scene), ms: 0 };
  if (!figures) figures = createFigures(view.scene, f); else figures.setField(f);
  camera = createCamera(f); size();
  map = createMap(store, f, makeMapImage(f, terrain)); hud.map = map;
  ground(store.state.grid);
  world.ms = Math.round(performance.now() - t0);
}
const ground = on => { if (world) world.terrain.uni.uGrid.value = on ? 1 : 0; };

// ---- reach a world: the one in this tab, or a hosted one
function connect(url) {
  if (session) { session.onclose = null; session.close(); }
  status.textContent = url ? 'Connecting to ' + url.replace(/^wss?:\/\//, '') : '';
  inner = url ? new WsTransport(url) : new LocalTransport({ bots: params.has('bots') ? +params.get('bots') : 63, ...(startHour !== undefined ? { hour: startHour } : {}) });
  local = url ? null : inner;
  lagT = new LagTransport(inner, store.state.lag / 2, store.state.lag * 0.12);
  const s = session = new Session(lagT, { name: saved.get('name', '') || 'Rider', token: url ? saved.get('token:' + url, '') : '', sample: controls.sample });
  if (seedBuilt < 0) setTimeout(() => makeField(WORLD_SEED), 0);   // the territory takes most of a second to lay out; start now, while the world starts up
  s.onwelcome = o => {
    if (url) saved.set('token:' + url, o.token);
    status.textContent = '';
    field = s.field;
    if (seedBuilt !== o.seed) {                                    // the ground and everything on it come from the seed
      seedBuilt = o.seed; building = true;
      status.textContent = 'Laying out the territory…';
      setTimeout(() => { buildWorld(field); building = false; status.textContent = ''; }, 20);
    }
    controls.intent.yaw = s.horse.yaw + (s.horse.z > s.z ? -0.35 : 0.35); controls.intent.pitch = -0.12;   // start out looking along your horse, with it in view
    hud.resetWorst(); hud.resetPlace();
  };
  s.onwhistle = e => sound.whistle(Math.hypot(e.x - s.x, e.z - s.z));
  s.onclose = reason => {
    if (s !== session) return;
    const why = s.state === 'rejected' ? s.reason : reason || 'The connection closed.';
    store.set({ mode: 'menu' }); controls.releaseLock();
    if (url) { status.textContent = why + ' Back in the world inside this tab.'; connect(''); } else status.textContent = why;
  };
  s.open();
}

function size() { const [w, h] = view.resize(); if (w > 0 && h > 0) { if (camera) camera.resize(w, h); fallbackCam.aspect = w / h; fallbackCam.updateProjectionMatrix(); } }   // a page opened out of sight has no size yet
addEventListener('resize', size);

// ---- the title card
const nameBox = $('name'), serverBox = $('server'), soundBox = $('sound');
nameBox.value = saved.get('name', ''); soundBox.checked = saved.get('sound', true) !== false;
$('joinBox').hidden = hosted; $('joinNote').hidden = !hosted;
if (preset) { serverBox.value = preset; $('joinBox').open = true; }
function setName() { const n = nameBox.value.replace(/[^\w \-]/g, '').trim().slice(0, 14); if (n !== saved.get('name', '')) { saved.set('name', n); return true; } return false; }
function play() {
  store.set({ mode: 'play' });
  sound.enabled = soundBox.checked; saved.set('sound', soundBox.checked); sound.start();
  canvas.focus();
  if (!coarse && canvas.requestPointerLock) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* drag to look instead */ } }
  // some pages (a preview frame, for one) are not allowed to capture the pointer; say how to look around there
  if (!coarse) setTimeout(() => document.documentElement.classList.toggle('drag', !store.state.locked), 500);
}
$('enter').addEventListener('submit', e => {
  e.preventDefault();
  if (setName() || !session || session.state !== 'playing') connect(inner instanceof WsTransport ? inner.url : '');   // a new name means a new hello
  play();
});
$('join').addEventListener('submit', e => {
  e.preventDefault();
  const url = serverBox.value.trim();
  if (!/^wss?:\/\/.+/.test(url)) { status.textContent = 'A server address starts with wss:// (or ws:// on your own machine).'; return; }
  setName(); connect(url); play();
});
store.on((s, p) => { if ('mode' in p) { $('menu').hidden = s.mode !== 'menu'; if (s.mode === 'menu') controls.releaseLock(); } });

// ---- the instruments, and the keys that are not movement
const toggle = (id, key) => { const b = $(id), f = () => { store.set({ [key]: !store.state[key] }); }; b.addEventListener('click', f); store.on((s, p) => { if (key in p) b.setAttribute('aria-pressed', String(s[key])); }); return f; };
const cyclePing = () => store.set({ lag: LAGS[(LAGS.indexOf(store.state.lag) + 1) % LAGS.length] });
const tBands = toggle('bBands', 'bandTint'), tGrid = toggle('bGrid', 'grid'), tStats = toggle('bStats', 'showStats');
$('bPing').addEventListener('click', cyclePing);
$('bMenu').addEventListener('click', () => store.set({ mode: 'menu' }));
store.on((s, p) => {
  if ('lag' in p && lagT) { lagT.lag = s.lag / 2; lagT.jitter = s.lag * 0.12; hud.resetWorst(); }
  if ('grid' in p) ground(s.grid);
  if ('locked' in p && !s.locked && s.mode === 'play' && !coarse && wasLocked && !(map && map.open)) store.set({ mode: 'menu' });   // Esc let go of the mouse
  if ('locked' in p) { wasLocked = s.locked; if (s.locked) document.documentElement.classList.remove('drag'); }
});
let wasLocked = false;
addEventListener('keydown', e => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'F3') { e.preventDefault(); tStats(); }
  else if (store.state.mode !== 'play') return;
  else if (e.code === 'KeyM' && map && !e.repeat) { map.toggle(); if (map.open) controls.releaseLock(); else if (!coarse && canvas.requestPointerLock) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* drag */ } } }
  else if (e.code === 'Escape') { if (map && map.open) map.close(); else store.set({ mode: 'menu' }); }
  else if (e.code === 'KeyL') cyclePing();
  else if (e.code === 'KeyB') tBands();
  else if (e.code === 'KeyG') tGrid();
});
$('mapClose').addEventListener('click', () => canvas.focus());

// ---- names over other people (not bots), near enough to matter
const tags = $('tags'), tagOf = new Map(), V = new globalThis.THREE.Vector3();
function nameTags(w, h) {
  for (const [id, el] of tagOf) if (!session.ents.has(id)) { el.remove(); tagOf.delete(id); }
  for (const e of session.ents.values()) {
    if ((e.ef & EF_BOT) || e.kind === KIND_HORSE) continue;
    let el = tagOf.get(e.id); if (!el) { el = document.createElement('span'); el.textContent = e.name; tags.appendChild(el); tagOf.set(e.id, el); }
    V.set(e.x, e.y + ((e.st & ST_RIDING) ? 2.95 : 2.15), e.z); const d = V.distanceTo(camera.cam.position); V.project(camera.cam);
    const on = d < 60 && V.z < 1 && Math.abs(V.x) < 1.1 && Math.abs(V.y) < 1.1;
    el.hidden = !on; if (on) el.style.transform = `translate(${((V.x + 1) / 2 * w).toFixed(1)}px, ${((1 - V.y) / 2 * h).toFixed(1)}px) translate(-50%, -100%)`;
  }
}

// ---- sounds that follow from what the player's own horse does
let lastWh = 0, lastMode = 0, lastRide = 0;
function horseSounds() {
  const a = session.a, h = a.h; if (!h) return;
  if (a.whT > lastWh + 30) sound.whistle(0);                       // this player's own whistle, the moment the key goes down
  lastWh = a.whT;
  if (lastMode === 1 && h.mode === 0 && horseNear(h, a.f)) sound.snort(2);
  if (a.riding && !lastRide) sound.snort(1);
  lastMode = h.mode; lastRide = a.riding;
}

// ---- every frame
let prev = performance.now(), frames = 0;
const wx = {};
function frame() {
  const now = performance.now(), gap = now - prev, dt = Math.min(0.1, gap / 1000); prev = now; frames++;
  // On a machine that cannot keep up, drawing back to back would leave no room for messages from the world to be
  // read, and the game would fall seconds behind. Below about 12 frames a second, let them through first.
  if (gap > 80) setTimeout(() => requestAnimationFrame(frame), 0); else requestAnimationFrame(frame);
  if (!session || session.state !== 'playing' || !field || building || !world) { view.render(fallbackCam); return; }
  session.frame(now);
  if (holding) return;                                             // an automated picture is being taken of the last frame drawn
  const playing = store.state.mode === 'play', a = session.a, i = controls.intent, time = now / 1000;
  const riding = a.riding && a.h ? 1 : 0, speed = riding ? Math.abs(a.h.sp) : Math.hypot(a.f.vx, a.f.vz);
  // the light and the weather, from the world's clock
  const hour = forced.hour !== undefined ? forced.hour : session.hour(now), w = forced.weather || weatherAt(now + session.tOff, session.x, session.z, field.terrain, field.seed, wx);
  view.setTime(hour, w.mist, w.cloud);
  const pc = typeof photo === 'function' ? photo(session) : photo;
  if (pc) { camera.cam.position.set(pc[0], pc[1], pc[2]); camera.cam.lookAt(pc[3], pc[4], pc[5]); }
  else if (playing) camera.follow(session.x, session.y, session.z, i.yaw, i.pitch, speed, dt, riding);
  else camera.circle(HUB_X - 30, field.base, HUB_Z, still ? 0 : dt);
  const eye = camera.cam.position, fx = playing && !photo ? session.x : eye.x, fz = playing && !photo ? session.z : eye.z;
  world.terrain.update(fx, fz, eye); world.trees.update(fx, fz, time); world.water.update(time, view.env, eye); world.towns.update(view.env); world.weather.update(w, camera.cam, time, view.env);
  figures.update(session, dt, store.state.bandTint, true, playing ? sound : null, view.env);
  view.render(camera.cam);
  if (holdWhen && holdWhen(session)) { holding = true; holdWhen = null; }
  if (playing) {
    horseSounds();
    sound.ambience({ height: session.y, speed, water: Math.max(0, field.terrain.riverDist(session.x, session.z) - 22), rapids: false, rain: w.rain, storm: w.cloud * w.rain, day: view.env.day }, dt);
    hud.stats(session, now, local ? local.total : 0, store.state.lag);
    hud.minimap(session, field, i.yaw, now, mapImageOf());
    hud.frame(session, field, i, now, hour, coarse);
    nameTags(canvas.clientWidth, canvas.clientHeight);
    if (map.open) map.draw(session, hour, i.yaw);
    if (coarse && riding !== touchRiding) { touchRiding = riding; $('tUse').textContent = riding ? 'Get down' : 'Mount'; $('tRun').textContent = riding ? 'Gallop' : 'Run'; }
  }
}
const mapImageOf = () => (map ? map.image : null);
let photo = null;                                                    // a fixed camera for automated pictures: [x, y, z, at x, at y, at z], or a function of the session giving one
let holdWhen = null, holding = false;                                // and a moment to stop drawing at, so a picture can be taken of it
const forced = {};                                                   // and a fixed hour or weather, for the same
let touchRiding = -1;

// a handle for automated checks, as HoodWar has with window.__pc
globalThis.__ct = { store, controls, get frames() { return frames; }, get session() { return session; }, get local() { return local; }, get camera() { return camera; }, get world() { return world; }, get map() { return map; }, view, sound, photo(p) { photo = p || null; }, force(o) { Object.assign(forced, o); }, hold(when) { holdWhen = when || null; holding = false; }, get holding() { return holding; } };

size();
connect(!hosted && preset ? preset : '');
if (!hosted && preset) play();
requestAnimationFrame(frame);
