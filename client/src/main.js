// The game page. It owns the frame loop and wires the pieces together; each piece is its own module:
//   net/        the session (prediction, reconciliation, interpolation) and the ways to reach a world
//   input/      keyboard, mouse and touch, turned into intent
//   player/     the camera
//   render/     scene, ground, props, figures
//   ui/         instruments and the title card
//   state/      the one shared store
import { createStore, saved } from './state/store.js';
import { createScene } from './render/scene.js';
import { createGround } from './render/ground.js';
import { createProps } from './render/props.js';
import { createFigures } from './render/figures.js';
import { createCamera } from './player/camera.js';
import { createControls } from './input/controls.js';
import { createHud } from './ui/hud.js';
import { Session } from './net/session.js';
import { WsTransport, LagTransport } from './net/transport.js';
import { LocalTransport } from './net/local.js';
import { HUB_X, HUB_Z, EF_BOT } from '../../shared/constants.js';

const $ = id => document.getElementById(id);
const app = $('app'), canvas = $('view'), status = $('status');
const hosted = app.dataset.host === 'artifact';          // inside a preview page that cannot open sockets
const coarse = matchMedia('(pointer: coarse)').matches, still = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (coarse) document.documentElement.classList.add('touch');

const store = createStore({ mode: 'menu', showStats: true, lag: 0, bandTint: false, grid: true, locked: false });
const view = createScene(canvas), controls = createControls(canvas, store), hud = createHud(store);
const LAGS = [0, 60, 150, 300];
let session = null, lagT = null, inner = null, local = null;       // local: the world in this tab, when that is what we are in
let field = null, ground = null, props = null, figures = null, camera = null, seedBuilt = -1;

// ---- reach a world: the one in this tab, or a hosted one
function connect(url) {
  if (session) { session.onclose = null; session.close(); }
  status.textContent = url ? 'Connecting to ' + url.replace(/^wss?:\/\//, '') : '';
  inner = url ? new WsTransport(url) : new LocalTransport({ bots: 63 });
  local = url ? null : inner;
  lagT = new LagTransport(inner, store.state.lag / 2, store.state.lag * 0.12);
  const s = session = new Session(lagT, { name: saved.get('name', '') || 'Rider', token: url ? saved.get('token:' + url, '') : '', sample: controls.sample });
  s.onwelcome = o => {
    if (url) saved.set('token:' + url, o.token);
    status.textContent = '';
    if (seedBuilt !== o.seed) {                                    // the ground and everything on it come from the seed
      for (const m of [ground && ground.mesh, props]) if (m) view.scene.remove(m);
      field = s.field; seedBuilt = o.seed;
      ground = createGround(view.scene, field); props = createProps(view.scene, field);
      if (!figures) figures = createFigures(view.scene, field);
      camera = createCamera(field); size();
    }
    controls.intent.yaw = Math.atan2(o.x - HUB_X, o.z - HUB_Z) + Math.PI; // start out facing the hub
    hud.resetWorst();
  };
  s.onclose = reason => {
    if (s !== session) return;
    const why = s.state === 'rejected' ? s.reason : reason || 'The connection closed.';
    store.set({ mode: 'menu' }); controls.releaseLock();
    if (url) { status.textContent = why + ' Back in the world inside this tab.'; connect(''); } else status.textContent = why;
  };
  s.open();
}

function size() { const [w, h] = view.resize(); if (camera) camera.resize(w, h); }
addEventListener('resize', size);

// ---- the title card
const nameBox = $('name'), serverBox = $('server');
nameBox.value = saved.get('name', '');
$('join').hidden = hosted; $('joinNote').hidden = !hosted;
const params = new URLSearchParams(location.search), preset = params.get('server') || '';
if (preset) serverBox.value = preset;
function setName() { const n = nameBox.value.replace(/[^\w \-]/g, '').trim().slice(0, 14); if (n !== saved.get('name', '')) { saved.set('name', n); return true; } return false; }
function play() {
  store.set({ mode: 'play' });
  canvas.focus();
  if (!coarse && canvas.requestPointerLock) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* drag to look instead */ } }
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

// ---- test controls
const toggle = (id, key) => { const b = $(id), f = () => { store.set({ [key]: !store.state[key] }); }; b.addEventListener('click', f); store.on((s, p) => { if (key in p) b.setAttribute('aria-pressed', String(s[key])); }); return f; };
const cyclePing = () => store.set({ lag: LAGS[(LAGS.indexOf(store.state.lag) + 1) % LAGS.length] });
const tBands = toggle('bBands', 'bandTint'), tGrid = toggle('bGrid', 'grid'), tStats = toggle('bStats', 'showStats');
$('bPing').addEventListener('click', cyclePing);
$('bMenu').addEventListener('click', () => store.set({ mode: 'menu' }));
store.on((s, p) => {
  if ('lag' in p && lagT) { lagT.lag = s.lag / 2; lagT.jitter = s.lag * 0.12; hud.resetWorst(); }
  if ('grid' in p && ground) ground.uni.uGrid.value = s.grid ? 1 : 0;
  if ('locked' in p && !s.locked && s.mode === 'play' && !coarse && wasLocked) store.set({ mode: 'menu' });   // Esc let go of the mouse
  if ('locked' in p) wasLocked = s.locked;
});
let wasLocked = false;
addEventListener('keydown', e => {
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === 'F3') { e.preventDefault(); tStats(); }
  else if (store.state.mode !== 'play') return;
  else if (e.code === 'KeyL') cyclePing();
  else if (e.code === 'KeyB') tBands();
  else if (e.code === 'KeyG') tGrid();
  else if (e.code === 'Escape' || e.code === 'KeyM') store.set({ mode: 'menu' });
});
if (innerWidth < 760) store.set({ showStats: false });

// ---- names over other people (not bots), near enough to matter
const tags = $('tags'), tagOf = new Map(), V = new globalThis.THREE.Vector3();
function nameTags(w, h) {
  for (const [id, el] of tagOf) if (!session.ents.has(id)) { el.remove(); tagOf.delete(id); }
  for (const e of session.ents.values()) {
    if (e.ef & EF_BOT) continue;
    let el = tagOf.get(e.id); if (!el) { el = document.createElement('span'); el.textContent = e.name; tags.appendChild(el); tagOf.set(e.id, el); }
    V.set(e.x, e.y + 2.05, e.z); const d = V.distanceTo(camera.cam.position); V.project(camera.cam);
    const on = d < 60 && V.z < 1 && Math.abs(V.x) < 1.1 && Math.abs(V.y) < 1.1;
    el.hidden = !on; if (on) el.style.transform = `translate(${((V.x + 1) / 2 * w).toFixed(1)}px, ${((1 - V.y) / 2 * h).toFixed(1)}px) translate(-50%, -100%)`;
  }
}

// ---- every frame
let prev = performance.now(), frames = 0;
function frame() {
  const now = performance.now(), gap = now - prev, dt = Math.min(0.1, gap / 1000); prev = now; frames++;
  // On a machine that cannot keep up, drawing back to back would leave no room for messages from the world to be
  // read, and the game would fall seconds behind. Below about 12 frames a second, let them through first.
  if (gap > 80) setTimeout(() => requestAnimationFrame(frame), 0); else requestAnimationFrame(frame);
  if (!session || session.state !== 'playing' || !field) return;
  session.frame(now);
  const playing = store.state.mode === 'play', me = session.me, i = controls.intent;
  if (playing) camera.follow(session.x, session.y, session.z, i.yaw, i.pitch, Math.hypot(me.vx, me.vz), dt);
  else camera.circle(HUB_X, field.base, HUB_Z, still ? 0 : dt);
  ground.update(playing ? session.x : HUB_X, playing ? session.z : HUB_Z, camera.cam.position);
  figures.update(session, dt, store.state.bandTint, true);
  view.render(camera.cam);
  if (playing) {
    hud.stats(session, now, local ? local.total : 0, store.state.lag);
    hud.radar(session, i.yaw, now); hud.pace(session, i);
    nameTags(canvas.clientWidth, canvas.clientHeight);
  }
}

// a handle for automated checks, as HoodWar has with window.__pc
globalThis.__ct = { store, controls, get frames() { return frames; }, get session() { return session; }, get local() { return local; }, get camera() { return camera; }, view };

size();
connect(!hosted && preset ? preset : '');
if (!hosted && preset) play();
requestAnimationFrame(frame);
