// Iron Nerve: this game's focus mode. Time does not slow (it cannot, for one player in a shared world): the gun
// steadies, the picture turns to old sepia, the world's sounds fall back behind a heartbeat, and each pull of the
// trigger puts a mark on whoever is under the sights instead of firing. Press Q again, run out of nerve, or mark as
// many as there are rounds in the gun, and it fires at each mark in turn, as fast as the hammer comes back in focus.
//
// All of that is on this screen. What reaches the server is ordinary input: where the view points and when the
// trigger is pulled, with the focus key held. The server already holds the shooter to the gun's rate (quicker in
// focus, while the meter lasts) and judges each shot itself, so marking and firing grant nothing a steady hand
// could not do. It is aim assistance the player asks for, in plain sight, which is all a browser game can offer.
import { GUNS, GF, AIM, magOf } from '../../../shared/sim/guns.js';
import { rayPerson } from '../../../shared/world/raycast.js';
import { KIND_HORSE, GR_DEAD, ST_RIDING } from '../../../shared/constants.js';
import { SIN16, COS16 } from '../../../shared/sim/trig.js';
import { THREE } from '../render/three.js';

const TAU = Math.PI * 2;
export function createNerve(controls, sound, view) {
  const marks = [], spans = [], box = document.getElementById('marks'), root = document.documentElement;
  const o = { yaw: 0, pitch: 0, pull: false, focus: true };       // what the controls send while the marks are fired
  const V = new THREE.Vector3(), D = new THREE.Vector3(), pz = { zone: 0 };
  let active = false, firing = false, idx = 0, beatAt = 0, clicks = 0, settle = 0;

  function start() { active = true; marks.length = 0; clicks = controls.intent.clicks; sound.focus(true); root.classList.add('nerve'); beatAt = 0; }
  function end() {
    active = false; firing = false; marks.length = 0; controls.intent.override = null; controls.intent.focus = false;
    sound.focus(false); root.classList.remove('nerve'); for (const s of spans) s.hidden = true;
  }
  const alive = (s, m) => { const e = s.ents.get(m.id); return !!e && !(e.gear & GR_DEAD); };
  // the view's yaw and pitch that put the shot line through (tx, ty, tz)
  function aimAt(a, tx, ty, tz, out) {
    let yaw = controls.intent.yaw, pitch = 0;
    for (let k = 0; k < 3; k++) {
      const yi = Math.round(yaw / TAU * 65536) & 65535, sh = a.riding ? AIM.rideShoulder : AIM.shoulder, hd = (a.riding ? AIM.rideHead : AIM.head) + AIM.up;
      const ox = a.f.x + COS16[yi] * sh, oy = a.f.y + hd, oz = a.f.z - SIN16[yi] * sh, dx = tx - ox, dy = ty - oy, dz = tz - oz;
      yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    // keep the view's turn short: the same direction, nearest the current yaw
    const cur = controls.intent.yaw; yaw = cur + Math.atan2(Math.sin(yaw - cur), Math.cos(yaw - cur));
    out.yaw = yaw; out.pitch = pitch;
  }
  // a mark on whoever is under the sights, at the point the sights are on
  function mark(session, cam, field) {
    const a = session.a, G = GUNS[a.slot]; if (!G || marks.length >= magOf(a)) return false;
    cam.getWorldDirection(D); V.copy(cam.position);
    let best = null, bt = G.range;
    for (const e of session.ents.values()) {
      if (e.kind === KIND_HORSE || (e.gear & GR_DEAD)) continue;
      const t = rayPerson(V.x, V.y, V.z, D.x, D.y, D.z, e.x, e.y, e.z, (e.st & ST_RIDING) !== 0, bt, pz);
      if (t < bt) { bt = t; best = e; }
    }
    if (!best) return false;
    if (field.boxes.ray(V.x, V.y, V.z, D.x, D.y, D.z, bt) < bt || field.trees.ray(V.x, V.y, V.z, D.x, D.y, D.z, bt) < bt) return false;   // not through walls
    marks.push({ id: best.id, ox: V.x + D.x * bt - best.x, oy: V.y + D.y * bt - best.y, oz: V.z + D.z * bt - best.z });
    sound.click(0);
    return true;
  }
  const aim = { yaw: 0, pitch: 0 };
  return {
    get active() { return active || firing; },
    get firing() { return firing; },
    // every frame, before the session samples the controls
    frame(session, camera, field, now) {
      const a = session.a, intent = controls.intent, inFocus = (a.gfl & GF.IN_FOCUS) !== 0;
      if (!active && !firing) { if (inFocus && intent.focus) start(); else return; }
      if (a.dead || !a.slot) { end(); return; }
      if (active && !firing) {
        while (clicks < intent.clicks) { clicks++; mark(session, camera.cam, field); }
        // fire the marks: Q again, the meter spent, or a mark for every round
        const done = !intent.focus || !inFocus || marks.length >= magOf(a);
        if (done) {
          if (marks.length && magOf(a) > 0) { firing = true; active = false; idx = 0; settle = 0; o.pull = false; intent.override = o; intent.focus = true; }
          else { end(); return; }
        }
      }
      if (firing) {
        while (idx < marks.length && !alive(session, marks[idx])) idx++;
        if (idx >= marks.length || (magOf(a) === 0 && !a.rel)) { end(); return; }
        const m = marks[idx], e = session.ents.get(m.id);
        aimAt(a, e.x + m.ox, e.y + m.oy, e.z + m.oz, aim);
        o.yaw = aim.yaw; o.pitch = aim.pitch; intent.yaw = aim.yaw; intent.pitch = aim.pitch;   // the view swings to each mark in turn
        if (++settle >= 2 && a.cool === 0 && !a.swap && magOf(a) > 0) o.pull = true;           // the controls take it, once
      }
      if (now > beatAt) { sound.heartbeat(); beatAt = now + 760; }
      // the marks, drawn where they are
      const cam = camera.cam, w = innerWidth, h = innerHeight;
      for (let i = 0; i < Math.max(marks.length, spans.length); i++) {
        let sp = spans[i]; if (!sp && i < marks.length) { sp = spans[i] = document.createElement('span'); box.appendChild(sp); }
        if (!sp) continue;
        const m = marks[i], e = m && i >= idx ? session.ents.get(m.id) : null;
        if (!e) { sp.hidden = true; continue; }
        V.set(e.x + m.ox, e.y + m.oy, e.z + m.oz).project(cam);
        sp.hidden = V.z > 1; if (!sp.hidden) sp.style.transform = `translate(${((V.x + 1) / 2 * w).toFixed(1)}px, ${((1 - V.y) / 2 * h).toFixed(1)}px)`;
      }
    },
    // the session predicted a shot: in the middle of firing the marks, on to the next
    shot() { if (firing) { idx++; settle = 0; } },
    end,
  };
}
