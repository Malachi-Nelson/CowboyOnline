// Keyboard, mouse and touch, turned into one "intent" the rest of the game reads: which way to move, where the
// view points, and which buttons are down. Nothing here knows about the network.
//
// Guns: 1 and 2 draw the revolver and the repeater (the same key again puts it away), the mouse wheel goes through
// them, the right button aims and the left fires (firing with nothing in hand draws the last gun), R reloads, Q
// while aiming is Iron Nerve, and holding X puts your hands up. Without pointer lock the left button drags the
// view, and a click (pressed and let go without dragging) fires.
import { BTN } from '../../../shared/sim/moveFoot.js';
import { WEAPON_SHIFT, GF } from '../../../shared/sim/guns.js';
import { clamp, TAU } from '../../../shared/math.js';

const PITCH_STEPS = 65536 / TAU;

export function createControls(canvas, store) {
  const intent = { mx: 0, mz: 0, yaw: 0, pitch: -0.12, sprint: false, jump: false, walk: false, use: false, whistle: false, active: false, moved: false,
    weapon: 0, lastGun: 1, aim: false, fire: false, reload: false, focus: false, hands: false, override: null, clicks: 0 };
  const keys = new Set();
  // a press shorter than one input step (a quick tap) would never be seen; keep it until it is
  const tapped = { use: false, whistle: false, jump: false, fire: false, reload: false };
  const gun = n => { intent.weapon = intent.weapon === n ? 0 : n; if (n) intent.lastGun = n; intent.hands = false; };
  let aimMouse = false, clickAt = 0, clickX = 0, clickY = 0, moveSum = 0;
  let locked = false, dragging = false, lastX = 0, lastY = 0, lockedAt = 0;
  const cap = v => (v > 120 ? 120 : v < -120 ? -120 : v);
  const playing = () => store.state.mode === 'play';
  const look = (dx, dy, k) => { intent.yaw = (intent.yaw - dx * k) % TAU; intent.pitch = clamp(intent.pitch - dy * k, -1.2, 0.55); };

  // ---- keyboard
  const MOVE = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], KeyD: [1, 0] };
  addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (playing() && (MOVE[e.code] || e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'KeyZ' && playing()) intent.walk = !intent.walk;
    if (e.code === 'KeyE' || e.code === 'KeyF') tapped.use = true; else if (e.code === 'KeyH') tapped.whistle = true; else if (e.code === 'Space') tapped.jump = true;
    else if (e.code === 'KeyR') tapped.reload = true;
    else if (e.code === 'Digit1' && playing()) gun(1); else if (e.code === 'Digit2' && playing()) gun(2);
    else if (e.code === 'KeyQ' && playing()) intent.focus = !intent.focus;
    else if (e.code === 'KeyX' && playing()) intent.weapon = 0;                 // hands up: away with the gun first
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  // ---- mouse: pointer lock where the browser allows it, otherwise hold a button and drag
  const fire = () => { if (!intent.weapon) intent.weapon = intent.lastGun; intent.hands = false; tapped.fire = true; intent.clicks++; };
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousedown', e => {
    if (!playing()) return;
    if (e.button === 2) { aimMouse = true; if (!intent.weapon) intent.weapon = intent.lastGun; intent.hands = false; }
    // locked, or aiming with the right button held (the right button then does the looking): the left fires at once
    if (e.button === 0 && (locked || aimMouse)) { fire(); keys.add('Mouse0'); clickAt = 0; return; }
    if (locked) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    if (e.button === 0) { clickAt = performance.now(); clickX = e.clientX; clickY = e.clientY; moveSum = 0; }
    if (canvas.requestPointerLock) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* drag instead */ } }
  });
  addEventListener('mouseup', e => {
    if (e.button === 0) keys.delete('Mouse0');
    if (!aimMouse || e.button === 2) dragging = false;
    if (e.button === 2) aimMouse = false;
    // dragging to look: a click that did not drag is a shot
    else if (e.button === 0 && !locked && clickAt && playing() && moveSum < 6 && performance.now() - clickAt < 700) fire();
    clickAt = 0;
  });
  addEventListener('wheel', e => { if (!playing() || !(locked || dragging || aimMouse)) return; const o = [0, 1, 2], i = o.indexOf(intent.weapon); intent.weapon = o[(i + (e.deltaY > 0 ? 1 : 2)) % 3]; if (intent.weapon) intent.lastGun = intent.weapon; }, { passive: true });
  addEventListener('mousemove', e => {
    if (!playing()) return;
    if (locked) { if (performance.now() - lockedAt > 120) look(cap(e.movementX), cap(e.movementY), aimMouse ? 0.0015 : 0.0023); }   // the first move after locking can be a wild jump; slower when aiming
    else if (dragging) { const dx = e.clientX - lastX, dy = e.clientY - lastY; moveSum += Math.abs(dx) + Math.abs(dy); look(dx, dy, aimMouse ? 0.0033 : 0.005); lastX = e.clientX; lastY = e.clientY; }
  });
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas; lockedAt = performance.now(); store.set({ locked }); });
  document.addEventListener('pointerlockerror', () => { locked = false; });

  // ---- touch: left half is a stick, right half turns the view; round buttons for the rest
  const stick = { id: -1, x0: 0, y0: 0, x: 0, y: 0 }, view = { id: -1, x: 0, y: 0 };
  const knob = document.getElementById('stick'), nub = knob && knob.firstElementChild;
  const touch = { sprint: false, jump: false, use: false, whistle: false, aim: false, hands: false };
  const showStick = on => { if (!knob) return; knob.hidden = !on; if (on) { knob.style.left = stick.x0 + 'px'; knob.style.top = stick.y0 + 'px'; } };
  canvas.addEventListener('touchstart', e => {
    if (!playing()) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.5 && stick.id < 0) { stick.id = t.identifier; stick.x0 = stick.x = t.clientX; stick.y0 = stick.y = t.clientY; showStick(true); }
      else if (view.id < 0) { view.id = t.identifier; view.x = t.clientX; view.y = t.clientY; }
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === stick.id) { stick.x = t.clientX; stick.y = t.clientY; if (nub) { const dx = stick.x - stick.x0, dy = stick.y - stick.y0, l = Math.hypot(dx, dy) || 1, k = Math.min(l, 56) / l; nub.style.transform = `translate(${dx * k}px, ${dy * k}px)`; } }
      else if (t.identifier === view.id) { look(t.clientX - view.x, t.clientY - view.y, 0.006); view.x = t.clientX; view.y = t.clientY; }
    }
  }, { passive: false });
  const end = e => { for (const t of e.changedTouches) { if (t.identifier === stick.id) { stick.id = -1; showStick(false); if (nub) nub.style.transform = ''; } if (t.identifier === view.id) view.id = -1; } };
  canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);
  const hold = (id, on, toggle) => {
    const b = document.getElementById(id); if (!b) return;
    const set = v => e => { e.preventDefault(); on(v); b.classList.toggle('on', toggle ? toggle() : v); };
    b.addEventListener('touchstart', set(true), { passive: false }); b.addEventListener('touchend', set(false), { passive: false }); b.addEventListener('touchcancel', set(false), { passive: false });
  };
  hold('tJump', v => { touch.jump = v; if (v) tapped.jump = true; });
  hold('tRun', v => { if (v) touch.sprint = !touch.sprint; }, () => touch.sprint);
  hold('tUse', v => { touch.use = v; if (v) tapped.use = true; });
  hold('tWhistle', v => { touch.whistle = v; if (v) tapped.whistle = true; });
  hold('tGun', v => { if (v) { const o = [0, 1, 2]; intent.weapon = o[(o.indexOf(intent.weapon) + 1) % 3]; if (intent.weapon) intent.lastGun = intent.weapon; } });
  hold('tAim', v => { touch.aim = v; if (v && !intent.weapon) intent.weapon = intent.lastGun; }, () => touch.aim);
  hold('tFire', v => { if (v) fire(); });
  hold('tReload', v => { if (v) tapped.reload = true; });
  hold('tFocus', v => { if (v) intent.focus = !intent.focus; }, () => intent.focus);

  // ---- read once per input step
  function read() {
    let mx = 0, mz = 0;
    const p = playing();
    if (p) {
      for (const k of keys) { const m = MOVE[k]; if (m) { mx += m[0]; mz += m[1]; } }
      if (keys.has('ArrowLeft')) intent.yaw += 0.03; if (keys.has('ArrowRight')) intent.yaw -= 0.03;
      if (stick.id >= 0) { const dx = (stick.x - stick.x0) / 56, dy = (stick.y - stick.y0) / 56, l = Math.hypot(dx, dy); if (l > 0.12) { const k = Math.min(l, 1) / l; mx = dx * k; mz = -dy * k; } }
      else { const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; } }
    }
    intent.mx = mx; intent.mz = mz;
    intent.sprint = p && (keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.sprint);
    intent.jump = p && (keys.has('Space') || touch.jump || tapped.jump);
    intent.use = p && (keys.has('KeyE') || keys.has('KeyF') || touch.use || tapped.use);
    intent.whistle = p && (keys.has('KeyH') || touch.whistle || tapped.whistle);
    intent.aim = p && intent.weapon !== 0 && (aimMouse || touch.aim);
    intent.fire = p && (tapped.fire || keys.has('Mouse0'));
    intent.reload = p && (keys.has('KeyR') || tapped.reload);
    intent.hands = p && keys.has('KeyX') && intent.weapon === 0;
    if (!intent.aim) intent.focus = false;                         // Iron Nerve ends when the gun comes down
    tapped.use = tapped.whistle = tapped.jump = tapped.fire = tapped.reload = false;
    intent.active = mx !== 0 || mz !== 0;
    if (intent.active) intent.moved = true;
    return intent;
  }
  // fill the input record the session sends: exactly these numbers go on the wire. Something else may steer the
  // aim for a moment (Iron Nerve firing its marks): intent.override = { yaw, pitch, fire }.
  function sample(cmd, session) {
    const i = read(), o = intent.override;
    cmd.mx = Math.round(i.mx * 127); cmd.mz = Math.round(i.mz * 127);
    const yaw = o ? o.yaw : i.yaw, pitch = o ? o.pitch : i.pitch;
    cmd.yaw = Math.round((((yaw % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
    cmd.pitch = Math.round(pitch * PITCH_STEPS);
    let fire;
    if (o) { fire = o.pull; o.pull = false; }                      // pulled once, for one input
    else fire = i.fire && !(i.focus && session && session.a.gfl & GF.IN_FOCUS);   // in Iron Nerve the trigger marks, it does not fire
    cmd.buttons = (i.sprint ? BTN.SPRINT : 0) | (i.jump ? BTN.JUMP : 0) | (i.walk && !i.sprint ? BTN.WALK : 0) | (i.use ? BTN.USE : 0) | (i.whistle ? BTN.WHISTLE : 0) |
      (i.aim || o ? BTN.AIM : 0) | (fire ? BTN.FIRE : 0) | (i.reload ? BTN.RELOAD : 0) | (i.focus || (o && o.focus) ? BTN.FOCUS : 0) | (i.hands ? BTN.HANDS : 0) | (i.weapon << WEAPON_SHIFT);
  }
  return { intent, sample, keys, releaseLock() { if (document.exitPointerLock && locked) document.exitPointerLock(); }, get locked() { return locked; }, get touch() { return stick.id >= 0 || view.id >= 0; }, get aiming() { return intent.aim; } };
}
