// Keyboard, mouse and touch, turned into one "intent" the rest of the game reads: which way to move, where the
// view points, and which buttons are down. Nothing here knows about the network.
import { BTN } from '../../../shared/sim/moveFoot.js';
import { clamp, TAU } from '../../../shared/math.js';

export function createControls(canvas, store) {
  const intent = { mx: 0, mz: 0, yaw: 0, pitch: -0.12, sprint: false, jump: false, walk: false, active: false, moved: false };
  const keys = new Set();
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
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  // ---- mouse: pointer lock where the browser allows it, otherwise hold a button and drag
  canvas.addEventListener('mousedown', e => {
    if (!playing()) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    if (!locked && canvas.requestPointerLock) { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (err) { /* drag instead */ } }
  });
  addEventListener('mouseup', () => { dragging = false; });
  addEventListener('mousemove', e => {
    if (!playing()) return;
    if (locked) { if (performance.now() - lockedAt > 120) look(cap(e.movementX), cap(e.movementY), 0.0023); }   // the first move after locking can be a wild jump
    else if (dragging) { look(e.clientX - lastX, e.clientY - lastY, 0.005); lastX = e.clientX; lastY = e.clientY; }
  });
  document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === canvas; lockedAt = performance.now(); store.set({ locked }); });
  document.addEventListener('pointerlockerror', () => { locked = false; });

  // ---- touch: left half is a stick, right half turns the view
  const stick = { id: -1, x0: 0, y0: 0, x: 0, y: 0 }, view = { id: -1, x: 0, y: 0 };
  const knob = document.getElementById('stick'), nub = knob && knob.firstElementChild;
  const touch = { sprint: false, jump: false };
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
  const hold = (id, on) => { const b = document.getElementById(id); if (!b) return; const set = v => e => { e.preventDefault(); on(v); b.classList.toggle('on', id === 'tRun' ? touch.sprint : v); }; b.addEventListener('touchstart', set(true), { passive: false }); b.addEventListener('touchend', set(false), { passive: false }); b.addEventListener('touchcancel', set(false), { passive: false }); };
  hold('tJump', v => { touch.jump = v; });
  hold('tRun', v => { if (v) touch.sprint = !touch.sprint; });

  // ---- read once per input step
  function read() {
    let mx = 0, mz = 0;
    if (playing()) {
      for (const k of keys) { const m = MOVE[k]; if (m) { mx += m[0]; mz += m[1]; } }
      if (keys.has('ArrowLeft')) intent.yaw += 0.03; if (keys.has('ArrowRight')) intent.yaw -= 0.03;
      if (stick.id >= 0) { const dx = (stick.x - stick.x0) / 56, dy = (stick.y - stick.y0) / 56, l = Math.hypot(dx, dy); if (l > 0.12) { const k = Math.min(l, 1) / l; mx = dx * k; mz = -dy * k; } }
      else { const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; } }
    }
    intent.mx = mx; intent.mz = mz;
    intent.sprint = playing() && (keys.has('ShiftLeft') || keys.has('ShiftRight') || touch.sprint);
    intent.jump = playing() && (keys.has('Space') || touch.jump);
    intent.active = mx !== 0 || mz !== 0;
    if (intent.active) intent.moved = true;
    return intent;
  }
  // fill the input record the session sends: exactly these numbers go on the wire
  function sample(cmd) {
    const i = read();
    cmd.mx = Math.round(i.mx * 127); cmd.mz = Math.round(i.mz * 127);
    cmd.yaw = Math.round((((i.yaw % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
    cmd.buttons = (i.sprint ? BTN.SPRINT : 0) | (i.jump ? BTN.JUMP : 0) | (i.walk && !i.sprint ? BTN.WALK : 0);
  }
  return { intent, sample, releaseLock() { if (document.exitPointerLock && locked) document.exitPointerLock(); }, get locked() { return locked; }, get touch() { return stick.id >= 0 || view.id >= 0; } };
}
