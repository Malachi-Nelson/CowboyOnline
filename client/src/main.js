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
import { createEffects } from './render/effects.js';
import { createNerve } from './player/nerve.js';
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
import { HUB_X, HUB_Z, EF_BOT, KIND_HORSE, ST_RIDING, WORLD_SEED, TICK_MS, GR_WITNESS, GR_WANTED, GR_DEAD } from '../../shared/constants.js';
import { horseNear } from '../../shared/sim/moveHorse.js';
import { GUNS, AIM, GF } from '../../shared/sim/guns.js';
import { EV, STRUCK, ZONE, NOTE } from '../../shared/net/messages.js';
import { rayGround, rayPerson, rayHorse } from '../../shared/world/raycast.js';
import { placeAt } from './ui/hud.js';

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
let field = null, world = null, figures = null, camera = null, map = null, effects = null, seedBuilt = -1, building = false;
const nerve = createNerve(controls, sound, view);

// everything drawn that comes from the world's seed: built once, when the first welcome says which world this is
function buildWorld(f) {
  if (world) for (const k of ['terrain', 'water', 'trees', 'towns', 'weather']) world[k].dispose();
  const t0 = performance.now(), terrain = createTerrain(view.scene, f, view.env);
  world = { terrain, water: createWater(view.scene, f), trees: createTrees(view.scene, f), towns: createTowns(view.scene, f), weather: createWeather(view.scene), ms: 0 };
  if (!figures) figures = createFigures(view.scene, f); else figures.setField(f);
  if (effects) effects.dispose(); effects = createEffects(view.scene, f);
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
  s.onshot = (a, seq) => ownShot(s, a);
  s.onevent = ev => onEvent(s, ev);
  let wasJailed = false;
  s.onstatus = st => { const j = (st.flags & 2) !== 0; if (j && !wasJailed) { controls.intent.weapon = 0; nerve.end(); } wasJailed = j; };   // taken in: the gun goes away and stays away
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
  else if (e.code === 'KeyB' && store.state.showStats) tBands();
  else if (e.code === 'KeyG' && store.state.showStats) tGrid();
});
$('mapClose').addEventListener('click', () => canvas.focus());

// ---- names over other people (not bots), near enough to matter
const tags = $('tags'), tagOf = new Map(), V = new globalThis.THREE.Vector3();
function nameTags(w, h) {
  for (const [id, el] of tagOf) if (!session.ents.has(id)) { el.remove(); tagOf.delete(id); }
  for (const e of session.ents.values()) {
    if (e.kind === KIND_HORSE) continue;
    const witness = (e.gear & GR_WITNESS) !== 0 && !(e.gear & GR_DEAD);
    if ((e.ef & EF_BOT) && !witness) { const old = tagOf.get(e.id); if (old) { old.remove(); tagOf.delete(e.id); } continue; }
    let el = tagOf.get(e.id); if (!el) { el = document.createElement('span'); tags.appendChild(el); tagOf.set(e.id, el); }
    const text = witness ? '!' : e.name; if (el.textContent !== text) el.textContent = text;
    el.className = witness ? 'witness' : (e.gear & GR_WANTED) ? 'wanted' : '';
    V.set(e.x, e.y + ((e.st & ST_RIDING) ? 2.95 : 2.15), e.z); const d = V.distanceTo(camera.cam.position); V.project(camera.cam);
    const on = d < (witness ? 90 : 60) && V.z < 1 && Math.abs(V.x) < 1.1 && Math.abs(V.y) < 1.1;
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

// ---- gunfire, as this screen shows it
const TAU = Math.PI * 2, hitP = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, struck: 0 }, gnd = { water: false }, pz = { zone: 0 };
const me = { aiming: false, aimYaw: 0, pitch: 0, hurt: 0, hurtZone: 0, hurtYaw: 0 };
// Where a shot from (ox, oy, oz) going (dx, dy, dz) lands among what is drawn here, and what it strikes. The server
// decides what was really hit; this is for the dust and the splinters.
function traceLocal(ox, oy, oz, dx, dy, dz, range, skip, out = hitP) {
  const B = field.boxes; let t = B.ray(ox, oy, oz, dx, dy, dz, range), struck = t < range ? STRUCK.WOOD : STRUCK.AIR, box = B.hit;
  const tt = field.trees.ray(ox, oy, oz, dx, dy, dz, t); if (tt < t) { t = tt; struck = STRUCK.TREE; }
  const tg = rayGround(field.terrain, ox, oy, oz, dx, dy, dz, t, gnd); if (tg < t) { t = tg; struck = gnd.water ? STRUCK.WATER : STRUCK.GROUND; }
  for (const e of session.ents.values()) {
    if (e === skip || (e.kind !== KIND_HORSE && (e.gear & GR_DEAD))) continue;
    const tb = e.kind === KIND_HORSE ? rayHorse(ox, oy, oz, dx, dy, dz, e.x, e.y, e.z, e.yaw, t) : rayPerson(ox, oy, oz, dx, dy, dz, e.x, e.y, e.z, (e.st & ST_RIDING) !== 0, t, pz);
    if (tb < t) { t = tb; struck = e.kind === KIND_HORSE ? STRUCK.HORSE : STRUCK.BODY; }
  }
  out.x = ox + dx * t; out.y = oy + dy * t; out.z = oz + dz * t; out.struck = struck; out.t = t;
  // the way the surface faces: a wall's face, the slope of the ground, straight up off water, back at the gun off a body
  if (struck === STRUCK.WOOD && box) {
    const c = [[out.x - box.x0, -1, 0, 0], [box.x1 - out.x, 1, 0, 0], [out.y - box.y0, 0, -1, 0], [box.y1 - out.y, 0, 1, 0], [out.z - box.z0, 0, 0, -1], [box.z1 - out.z, 0, 0, 1]].sort((p, q) => Math.abs(p[0]) - Math.abs(q[0]))[0];
    out.nx = c[1]; out.ny = c[2]; out.nz = c[3];
  } else if (struck === STRUCK.GROUND) { const T = field.terrain, gx = T.heightAt(out.x - 0.5, out.z) - T.heightAt(out.x + 0.5, out.z), gz = T.heightAt(out.x, out.z - 0.5) - T.heightAt(out.x, out.z + 0.5), l = Math.hypot(gx, 1, gz); out.nx = gx / l; out.ny = 1 / l; out.nz = gz / l; }
  else if (struck === STRUCK.WATER) { out.nx = 0; out.ny = 1; out.nz = 0; }
  else { out.nx = -dx; out.ny = -dy; out.nz = -dz; }
  return out;
}
// where the muzzle of a gun held out along (yaw, pitch) is, for someone standing (or riding) at (x, y, z)
function muzzleOf(x, y, z, yaw, pitch, riding, out) {
  const cp = Math.cos(pitch), fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp, rx = Math.cos(yaw), rz = -Math.sin(yaw);
  out[0] = x + rx * 0.28 + fx * 0.9; out[1] = y + (riding ? 2.25 : 1.43) + fy * 0.9; out[2] = z + rz * 0.28 + fz * 0.9;
  return out;
}
const mz = [0, 0, 0];
const inTown = (x, z) => !!(field && placeAt(field, x, z, 0));
const snowy = (x, y, z) => field.terrain.maskAt(x, z, 0) > 0.5 || y > 250;
function ownShot(s, a) {
  if (!effects || !field) return;
  const G = GUNS[a.fired], h = traceLocal(a.ox, a.oy, a.oz, a.dx, a.dy, a.dz, G.range, null);
  muzzleOf(s.x, s.y, s.z, controls.intent.yaw, controls.intent.pitch, a.riding, mz);
  effects.muzzle(mz[0], mz[1], mz[2], a.dx, a.dy, a.dz, a.fired, true);
  effects.tracer(mz[0], mz[1], mz[2], h.x, h.y, h.z);
  if (h.struck !== STRUCK.AIR) effects.impact(h.x, h.y, h.z, h.nx, h.ny, h.nz, h.struck, snowy(h.x, h.y, h.z));
  if (h.struck === STRUCK.WOOD) effects.hole(h.x, h.y, h.z, h.nx, h.ny, h.nz);
  sound.shot(a.fired, 0, inTown(s.x, s.z)); if (h.struck !== STRUCK.AIR) sound.impact(h.struck, h.t);
  setTimeout(() => sound.cock(a.fired === 2 ? 2 : 1), a.fired === 2 ? 260 : 170);
  figures.kickSelf(); if (camera) camera.recoil(a.fired === 2 ? 0.035 : 0.024);
  nerve.shot();
}
const NOTES = {
  [NOTE.SEEN]: () => 'Someone saw that.', [NOTE.WITNESS]: v => `${v === 1 ? 'A witness is' : v + ' witnesses are'} going to the law.`,
  [NOTE.REPORTED]: () => 'A witness has told the law.', [NOTE.WANTED]: v => `Wanted. $${v} on your head.`,
  [NOTE.ESCAPED]: v => `You got away${v ? `. The $${v} bounty stands` : ''}.`, [NOTE.ARRESTED]: () => 'Arrested.', [NOTE.RELEASED]: () => 'You have done your time. You are free to go.',
  [NOTE.LAW_SEES]: () => 'The law has spotted you.', [NOTE.LOST_THEM]: () => 'Out of sight. Keep moving.', [NOTE.POSSE]: () => 'A posse is riding out after you.',
};
function onEvent(s, ev) {
  if (!effects || !field) return;
  const now = performance.now();
  if (ev.type === EV.SHOT) {
    if (ev.id === s.id) return;                                    // already shown, the moment the trigger went
    const e = s.ents.get(ev.id); if (!e) return;
    const yaw = ev.yaw / 65536 * TAU, pitch = ev.pitch / 65536 * TAU, cp = Math.cos(pitch), dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
    const riding = (e.st & ST_RIDING) !== 0, sh = riding ? AIM.rideShoulder : AIM.shoulder, hd = (riding ? AIM.rideHead : AIM.head) + AIM.up;
    const ox = e.x + Math.cos(yaw) * sh, oy = e.y + hd, oz = e.z - Math.sin(yaw) * sh, ex = ox + dx * ev.dist, ey = oy + dy * ev.dist, ez = oz + dz * ev.dist;
    const d = Math.hypot(e.x - s.x, e.z - s.z);
    muzzleOf(e.x, e.y, e.z, yaw, pitch, riding, mz);
    effects.muzzle(mz[0], mz[1], mz[2], dx, dy, dz, ev.gun, d < 60);
    effects.tracer(mz[0], mz[1], mz[2], ex, ey, ez);
    if (ev.struck !== STRUCK.AIR) {
      const h = traceLocal(ox, oy, oz, dx, dy, dz, ev.dist + 0.5, null);       // for the surface's facing
      effects.impact(ex, ey, ez, h.nx, h.ny, h.nz, ev.struck, snowy(ex, ey, ez));
      if (ev.struck === STRUCK.WOOD) effects.hole(ex, ey, ez, h.nx, h.ny, h.nz);
      sound.impact(ev.struck, Math.hypot(ex - s.x, ez - s.z));
    }
    sound.shot(ev.gun, d, inTown(e.x, e.z));
    // close past this player's head: the crack of it going by
    const px = s.x - ox, py = s.y + 1.6 - oy, pz2 = s.z - oz, along = px * dx + py * dy + pz2 * dz;
    if (along > 2 && along < ev.dist + 1) { const miss = Math.sqrt(Math.max(0, px * px + py * py + pz2 * pz2 - along * along)); if (miss < 4) sound.whiz(miss); }
    figures.kick(e.anim);
  } else if (ev.type === EV.HIT) {
    const yaw = ev.yaw / 65536 * TAU;
    if (ev.id === s.id) {
      me.hurt = 1; me.hurtZone = ev.zone; me.hurtYaw = yaw;
      hud.damage(-((yaw + Math.PI) - controls.intent.yaw)); sound.hurt(ev.dmg >= 40);
      effects.impact(s.x, s.y + (ev.zone === ZONE.HEAD ? 1.6 : ev.zone === ZONE.LEGS ? 0.6 : 1.2) + (s.a.riding ? 0.8 : 0), s.z, Math.sin(yaw), 0.2, Math.cos(yaw), STRUCK.BODY);
    } else {
      const v = s.ents.get(ev.id);
      if (v && ev.zone !== ZONE.HORSE) {
        v.hurt = 1; v.hurtZone = ev.zone; v.hurtYaw = yaw;
        const rid = (v.st & ST_RIDING) ? 0.8 : 0, y = v.y + rid + (ev.zone === ZONE.HEAD ? 1.6 : ev.zone === ZONE.LEGS ? 0.55 : 1.15);
        if (ev.by !== s.id) effects.impact(v.x, y, v.z, -Math.sin(yaw), 0.2, -Math.cos(yaw), STRUCK.BODY);
      } else if (v) { effects.impact(v.x, v.y + 1.2, v.z, -Math.sin(yaw), 0.2, -Math.cos(yaw), STRUCK.HORSE); }
    }
    if (ev.by === s.id && ev.zone !== ZONE.HORSE) { hud.hit(false); s.stats.hitsMade = (s.stats.hitsMade || 0) + 1; }
  } else if (ev.type === EV.DIE) {
    if (ev.by === s.id && ev.id !== s.id) hud.hit(true);
    if (ev.id === s.id) { const k = s.ents.get(ev.by); s.killer = k ? (k.name || 'someone') : ''; nerve.end(); }
  } else if (ev.type === EV.NOTE) {
    const f = NOTES[ev.code]; if (f) hud.note(f(ev.value), now);
  }
}

// ---- every frame
let prev = performance.now(), frames = 0, prevCool = 0, prevRounds = 0;
const wx = {};
function frame() {
  const now = performance.now(), gap = now - prev, dt = Math.min(0.1, gap / 1000); prev = now; frames++;
  // On a machine that cannot keep up, drawing back to back would leave no room for messages from the world to be
  // read, and the game would fall seconds behind. Below about 12 frames a second, let them through first.
  if (gap > 80) setTimeout(() => requestAnimationFrame(frame), 0); else requestAnimationFrame(frame);
  if (!session || session.state !== 'playing' || !field || building || !world) { view.render(fallbackCam); return; }
  if (camera) nerve.frame(session, camera, field, now);              // Iron Nerve may steer the aim this frame
  session.frame(now);
  if (holding) return;                                             // an automated picture is being taken of the last frame drawn
  const playing = store.state.mode === 'play', a = session.a, i = controls.intent, time = now / 1000;
  const riding = a.riding && a.h ? 1 : 0, speed = riding ? Math.abs(a.h.sp) : Math.hypot(a.f.vx, a.f.vz);
  // the light and the weather, from the world's clock
  const hour = forced.hour !== undefined ? forced.hour : session.hour(now), w = forced.weather || weatherAt(now + session.tOff, session.x, session.z, field.terrain, field.seed, wx);
  view.setTime(hour, w.mist, w.cloud);
  const pc = typeof photo === 'function' ? photo(session) : photo;
  const aimUp = playing && i.aim && a.slot !== 0 && !a.swap && !a.dead ? 1 : 0, inFocus = (a.gfl & GF.IN_FOCUS) ? 1 : 0;
  if (pc) { camera.cam.position.set(pc[0], pc[1], pc[2]); camera.cam.lookAt(pc[3], pc[4], pc[5]); }
  else if (playing) camera.follow(session.x, session.y, session.z, i.yaw, i.pitch, speed, dt, riding, aimUp, inFocus);
  else camera.circle(HUB_X - 30, field.base, HUB_Z, still ? 0 : dt);
  const eye = camera.cam.position, fx = playing && !photo ? session.x : eye.x, fz = playing && !photo ? session.z : eye.z;
  world.terrain.update(fx, fz, eye); world.trees.update(fx, fz, time); world.water.update(time, view.env, eye); world.towns.update(view.env); world.weather.update(w, camera.cam, time, view.env);
  me.aiming = !!aimUp; me.aimYaw = i.yaw; me.pitch = i.pitch; me.hurt = Math.max(0, me.hurt - dt * 2.5);
  figures.update(session, dt, store.state.bandTint, true, playing ? sound : null, view.env, me);
  effects.update(dt, view.scene.fog);
  // the gun's own small sounds: a round going in, the hammer falling on nothing
  const rounds = a.m1 + a.m2; if (rounds > prevRounds && a.rel >= 0 && prevRounds >= 0) sound.load(0); prevRounds = rounds;
  if (a.cool === 12 && prevCool !== 12 && !a.fired) sound.click(0); prevCool = a.cool;
  view.render(camera.cam);
  if (holdWhen && holdWhen(session)) { holding = true; holdWhen = null; }
  if (playing) {
    horseSounds();
    sound.ambience({ height: session.y, speed, water: Math.max(0, field.terrain.riverDist(session.x, session.z) - 22), rapids: false, rain: w.rain, storm: w.cloud * w.rain, day: view.env.day }, dt);
    hud.stats(session, now, local ? local.total : 0, store.state.lag);
    hud.minimap(session, field, i.yaw, now, mapImageOf());
    hud.frame(session, field, i, now, hour, coarse);
    hud.combat(session, i, now, camera.cam.fov, camera.aiming, speed);
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
