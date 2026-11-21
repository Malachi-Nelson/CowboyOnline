// What is on screen while playing, kept to the corners: a round map at the bottom left that turns with you, the
// time beside it, your horse's wind when it matters, what the keys will do right now at the bottom right, and the
// name of a place as you ride into it. The Phase 2 instruments (connection readout, test buttons) are still here,
// behind F3.
import { HUB_X, HUB_Z, CHUNK, EF_BOT, EF_LAW, KIND_HORSE, ST_RIDING, GR_WITNESS, GR_DEAD, HP_MAX } from '../../../shared/constants.js';
import { horseNear, HORSE } from '../../../shared/sim/moveHorse.js';
import { GUNS, GF, FOCUS, spreadOf, magOf, spareOf } from '../../../shared/sim/guns.js';
import { SS } from '../../../shared/net/messages.js';
import { distSeg } from '../../../shared/world/terrain.js';

const $ = id => document.getElementById(id);
const kb = n => (n >= 10240 ? (n / 1024).toFixed(0) : (n / 1024).toFixed(1)) + ' KB/s';
export const REGIONS = { north: 'Cold Lantern Heights', mount: 'The Sawback Range', forest: 'Sawback Foothills', desert: 'Dry Fork Basin', swamp: 'The Mirewood', plains: 'Calder Plains' };
export function regionOf(t, x, z) {
  if (t.maskAt(x, z, 4) > 0.5) return REGIONS.swamp;
  if (t.maskAt(x, z, 0) > 0.5) return REGIONS.north;
  if (t.maskAt(x, z, 3) > 0.5) return REGIONS.desert;
  if (t.maskAt(x, z, 1) > 0.4) return REGIONS.mount;
  if (t.maskAt(x, z, 2) > 0.5) return REGIONS.forest;
  return REGIONS.plains;
}
export function placeAt(field, x, z, pad = 25) {
  for (const p of field.places) if (Math.abs(z - p.z) < p.r + pad && distSeg(x, z, p.ax || p.x, p.z, p.bx || p.x, p.z) < p.r + pad) return p;
  return null;
}
export const clockText = h => { const m = Math.floor(h * 60) % 1440, hh = Math.floor(m / 60), mm = m % 60; return `${(hh + 11) % 12 + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };

export function createHud(store) {
  const el = { hud: $('hud'), wire: $('wire'), bar: $('bar'), mini: $('minimap'), clock: $('clock'), core: $('horseCore'), ring: $('coreRing'), prompts: $('prompts'), place: $('place'), hint: $('hint'), pace: $('pace'), ping: $('bPing'), vals: {},
    fig: $('mini'), hpCore: $('hpCore'), hpRing: $('hpRing'), nCore: $('nerveCore'), nRing: $('nerveRing'), reticle: $('reticle'), hitmark: $('hitmark'), dmg: $('dmgDir'), law: $('law'), note: $('note'), ammo: $('ammo'), down: $('down') };
  for (const d of el.wire.querySelectorAll('[data-k]')) el.vals[d.dataset.k] = d;
  const ctx = el.mini.getContext('2d');
  let last = null, at = 0, frames = 0, fps = 0, miniAt = 0, worst = 0, scale = 0.6, where = '', whereAt = -1e9, promptKey = '', map = null, fadeAt = 0;
  let noteAt = 0, ammoKey = '', lawKey = '', downKey = '', gap = -1;
  const restart = (n, cls) => { n.classList.remove('on'); void n.offsetWidth; n.classList.add('on'); if (cls !== undefined) n.classList.toggle('kill', cls); };
  const set = (k, v, cls) => { const d = el.vals[k]; if (!d) return; if (d.textContent !== v) d.textContent = v; if (cls !== undefined && d.dataset.s !== cls) d.dataset.s = cls; };

  // ---- the instruments (F3)
  function stats(session, now, total, lag) {
    frames++;
    if (now - at < 500) return;
    const st = session.stats, dt = (now - at) / 1000; fps = frames / dt; frames = 0; at = now;
    if (el.wire.hidden) { last = null; return; }
    const cur = { i: st.bytesIn, o: st.bytesOut, s: st.snapshots };
    if (last) {
      const down = (cur.i - last.i) / dt, up = (cur.o - last.o) / dt;
      set('down', kb(down), down > 16384 ? 'bad' : ''); set('up', kb(up), up > 2048 ? 'bad' : ''); set('snaps', ((cur.s - last.s) / dt).toFixed(0) + ' a second');
    }
    last = cur;
    const rtt = session.rtt, mm = st.errLast * 1000; if (mm > worst) worst = mm;
    set('ping', rtt < 1 ? 'under 1 ms' : rtt.toFixed(0) + ' ms' + (lag ? ' (added)' : ''), rtt > 250 ? 'bad' : rtt > 120 ? 'warn' : 'good');
    set('view', total ? `${session.ents.size} of ${total - 1}` : `${session.ents.size}`);
    set('behind', session.nearDelay.toFixed(0) + ' ms ago');
    set('predict', (mm < 0.005 ? '0' : mm.toFixed(2)) + ' mm now, ' + (worst < 0.005 ? '0' : worst.toFixed(2)) + ' worst', worst > 100 ? 'bad' : worst > 10 ? 'warn' : 'good');
    set('fixes', String(st.corrections), st.corrections > 5 ? 'warn' : '');
    set('ahead', String((session.seq - session.ack - 1) & 65535));
    set('fps', fps.toFixed(0) + ' a second', fps < 45 ? 'bad' : fps < 57 ? 'warn' : 'good');
    const m = session.me, cx = Math.floor(m.x / CHUNK), cz = Math.floor(m.z / CHUNK), d = Math.hypot(m.x - HUB_X, m.z - HUB_Z);
    set('where', `${d.toFixed(0)} m from the hub, square ${cx}.${cz}`);
    const a = session.a, sp = a.riding && a.h ? Math.abs(a.h.sp) : Math.hypot(m.vx, m.vz);
    el.pace.textContent = `${a.riding ? 'Riding' : m.ground ? 'On foot' : 'In the air'} · ${sp.toFixed(1)} m/s`;
  }

  // ---- the round map: the territory under you, turned so that ahead is up
  function minimap(session, field, yaw, now, mapImage) {
    if (now - miniAt < 66) return; miniAt = now;
    const cv = el.mini, dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth; if (!w || !mapImage) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = cv.height = Math.round(w * dpr); }
    const R = cv.width / 2, a = session.a, speed = a.riding && a.h ? Math.abs(a.h.sp) : 0;
    // metres across the radius: wider in the saddle at speed
    const want = R / (140 + speed * 14); scale += (want - scale) * 0.15;
    ctx.save(); ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.beginPath(); ctx.arc(R, R, R - dpr, 0, 6.2832); ctx.clip();
    ctx.translate(R, R); ctx.rotate(yaw);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mapImage, -session.x * scale, -session.z * scale, mapImage.width * mapImage.mpp * scale, mapImage.height * mapImage.mpp * scale);   // mpp: metres a pixel
    // your horse, and other people
    const dot = (x, z, r, fill, ring) => { let dx = (x - session.x) * scale, dz = (z - session.z) * scale; const l = Math.hypot(dx, dz), lim = R - 7 * dpr; if (l > lim) { dx *= lim / l; dz *= lim / l; } ctx.beginPath(); ctx.arc(dx, dz, r * dpr, 0, 6.2832); ctx.fillStyle = fill; ctx.fill(); if (ring) { ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = ring; ctx.stroke(); } };
    // the law looking for you: a red circle where it is searching
    const st = session.status;
    if (st.wanted && st.sr) { ctx.beginPath(); ctx.arc((st.sx - session.x) * scale, (st.sz - session.z) * scale, st.sr * 4 * scale, 0, 6.2832); ctx.fillStyle = 'rgba(200,50,30,0.18)'; ctx.fill(); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = 'rgba(230,80,50,0.75)'; ctx.stroke(); }
    for (const e of session.ents.values()) {
      if (e.kind === KIND_HORSE || (e.gear & GR_DEAD)) continue;
      if (e.ef & EF_LAW) dot(e.x, e.z, 3.4, st.wanted ? '#e8402a' : '#7fa6d8', '#1d160b');
      else if (e.gear & GR_WITNESS) dot(e.x, e.z, 3.2, '#e6b955', '#1d160b');
      else if (!(e.ef & EF_BOT)) dot(e.x, e.z, 3.6, '#f1ead8', '#1d160b');
    }
    if (a.h && !a.riding) { dot(session.horse.x, session.horse.z, 5, '#dba64c', '#1d160b'); }
    ctx.rotate(-yaw);
    // north, on the rim
    const nx = -Math.sin(yaw) * (R - 11 * dpr), ny = -Math.cos(yaw) * (R - 11 * dpr);
    ctx.font = `600 ${11 * dpr}px 'Libre Franklin', sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(20,17,13,0.75)'; ctx.beginPath(); ctx.arc(nx, ny, 8 * dpr, 0, 6.2832); ctx.fill(); ctx.fillStyle = '#efe6d2'; ctx.fillText('N', nx, ny + 0.5 * dpr);
    // you: an arrow pointing the way you face
    ctx.fillStyle = '#efe6d2'; ctx.strokeStyle = '#1d160b'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, -8 * dpr); ctx.lineTo(5.5 * dpr, 6 * dpr); ctx.lineTo(0, 3 * dpr); ctx.lineTo(-5.5 * dpr, 6 * dpr); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(20,17,13,0.85)'; ctx.beginPath(); ctx.arc(R, R, R - dpr, 0, 6.2832); ctx.stroke();
  }

  // ---- the horse's wind, the clock, what the keys do, and where you are
  function frame(session, field, intent, now, hour, touch) {
    const a = session.a, h = a.h;
    const c = clockText(hour); if (el.clock.textContent !== c) el.clock.textContent = c;
    // horse core: a ring that empties as the gallop spends the horse's wind
    const show = !!(h && (a.riding || h.stam < 0.995 || h.mode === 1));
    if (el.core.hidden === show) el.core.hidden = !show;
    if (show) { const off = (1 - h.stam) * 113.1; el.ring.style.strokeDashoffset = off.toFixed(1); el.core.dataset.s = h.winded ? 'winded' : h.stam < 0.3 ? 'low' : ''; }
    // prompts
    const list = [];
    const st = session.status, down = a.dead || (st.flags & SS.JAILED);
    // the gun hand first, when there is a gun in it
    if (!down) {
      const G = GUNS[a.slot], focusOn = (a.gfl & GF.IN_FOCUS) !== 0;
      if (G && intent.aim) {
        if (focusOn) { list.push(['LMB', 'Mark a target']); list.push(['Q', 'Fire the marks']); }
        else { list.push(['LMB', magOf(a) ? 'Fire' : 'Empty']); if (a.focus >= FOCUS.min) list.push(['Q', 'Iron Nerve']); }
      } else if (G) { list.push(['RMB', 'Aim']); if (magOf(a) < G.mag && spareOf(a) > 0 && !a.rel) list.push(['R', 'Reload']); list.push([String(a.slot), 'Put away']); }
      else if (st.wanted && !a.riding) list.push(['X', 'Hands up']);
    }
    if (h && !down) {
      const d = Math.hypot(h.x - a.f.x, h.z - a.f.z);
      if (a.riding) { list.push(['E', 'Dismount']); list.push(['Shift', h.winded ? 'Winded' : 'Gallop']); list.push(['Space', 'Jump']); list.push(['Z', intent.walk ? 'Canter' : 'Trot']); }
      else if (horseNear(h, a.f) && Math.abs(h.sp) < HORSE.mountSpeed) list.push(['E', 'Mount']);
      else if (h.mode === 1) list.push(['', 'Your horse is coming']);
      if (!a.riding && d > HORSE.reach + 1 && h.mode !== 1) list.push(['H', a.whT > 0 ? 'Whistle' : d > 120 ? `Whistle for your horse · ${Math.round(d)} m` : 'Whistle for your horse']);
    }
    if (!a.slot && !down) list.push(['1 2', 'Revolver, repeater']);
    list.push(['M', 'Map']);
    const key = list.map(p => p.join(':')).join('|') + (touch ? 't' : '');
    if (key !== promptKey) {
      promptKey = key; el.prompts.textContent = '';
      for (const [k, t] of list) { if (touch && k === 'Z') continue; const li = document.createElement('li'); if (k && !touch) { const kbd = document.createElement('kbd'); kbd.textContent = k; li.appendChild(kbd); } li.appendChild(document.createTextNode(t)); if (t === 'Winded' || t === 'Empty') li.className = 'warn'; el.prompts.appendChild(li); }
      el.ammo.style.setProperty('--prompts', (touch ? 9.5 : el.prompts.offsetHeight / 16 + 0.6) + 'rem');
    }
    // a place's name as you come into it, or the country's as you cross into it
    const p = placeAt(field, session.x, session.z), name = p ? p.name : regionOf(field.terrain, session.x, session.z);
    if (name !== where && now - whereAt > 2500) {
      const first = !where; where = name; whereAt = now;
      el.place.querySelector('.name').textContent = name;
      el.place.querySelector('.sub').textContent = first ? 'Calder Territory · 1899' : p ? regionOf(field.terrain, p.x, p.z) : 'Calder Territory';
      el.place.classList.remove('gone'); el.place.hidden = false; fadeAt = now + 4800;
    }
    if (fadeAt && now > fadeAt) { el.place.classList.add('gone'); fadeAt = 0; }
    if (intent.moved && !el.hint.classList.contains('gone')) el.hint.classList.add('gone');
  }

  // ---- guns and the law: the sights, the rounds, health and Iron Nerve, what the law knows, and being down
  // fov: the camera's vertical field of view in degrees; aimK: how far into aiming the camera is (0..1)
  function combat(session, intent, now, fov, aimK, speed) {
    const a = session.a, st = session.status, G = GUNS[a.slot], down = a.dead || (st.flags & SS.JAILED);
    // the sights: with a gun in hand, opened out to the spread the next shot would have
    const showR = !!G && !a.swap && !down && !(document.documentElement.classList.contains('nerve') && false);
    if (el.reticle.hidden === showR) el.reticle.hidden = !showR;
    if (showR) {
      const sp = spreadOf(a, G, intent.aim, speed), px = Math.tan(sp) / Math.tan(fov * Math.PI / 360) * innerHeight / 2, g = Math.round(Math.max(3, Math.min(60, px)) * 2) / 2;
      if (g !== gap) { gap = g; el.reticle.style.setProperty('--gap', g + 'px'); }
      el.reticle.classList.toggle('hip', !intent.aim); el.reticle.classList.toggle('empty', magOf(a) === 0);
    }
    // the rounds
    const ak = G && !down ? `${a.slot}|${magOf(a)}|${spareOf(a)}|${a.rel > 0}` : '';
    if (ak !== ammoKey) {
      ammoKey = ak; el.ammo.hidden = !ak;
      if (ak) { el.ammo.querySelector('.gun').textContent = G.short; el.ammo.querySelector('.rounds').textContent = `${magOf(a)} / ${G.mag}`; el.ammo.querySelector('.spare').textContent = a.rel > 0 ? 'Reloading' : `${spareOf(a)} spare`; el.ammo.classList.toggle('empty', magOf(a) === 0 && !a.rel); el.ammo.classList.toggle('reloading', a.rel > 0); }
    }
    // health and Iron Nerve, as rings beside the map
    const hp = Math.max(0, Math.min(1, st.hp / HP_MAX)); el.hpRing.style.strokeDashoffset = ((1 - hp) * 113.1).toFixed(1); el.hpCore.dataset.s = hp < 0.35 ? 'low' : '';
    el.nRing.style.strokeDashoffset = ((1 - a.focus) * 113.1).toFixed(1); el.nCore.dataset.s = a.gfl & GF.IN_FOCUS ? 'on' : a.focus < FOCUS.min ? 'low' : '';
    el.fig.classList.toggle('armed', !!a.slot || a.focus < 1);
    // what the law knows
    const lk = st.wanted ? `w${st.wanted}|${st.bounty}|${st.flags & SS.SEEN}|${st.witnesses}` : st.witnesses ? `x${st.witnesses}` : '';
    if (lk !== lawKey) {
      lawKey = lk; el.law.hidden = !lk;
      if (lk) {
        el.law.querySelector('.tag').textContent = st.wanted ? (st.wanted >= 3 ? 'Dead or alive' : 'Wanted') : 'Witnessed';
        el.law.querySelector('.bounty').textContent = st.bounty ? `$${st.bounty} bounty` : '';
        el.law.querySelector('.what').textContent = !st.wanted ? `${st.witnesses === 1 ? 'Someone is' : st.witnesses + ' people are'} on the way to tell the law. Stop them, or get clear.`
          : st.flags & SS.SEEN ? (st.wanted >= 3 ? 'A posse is riding you down. Put your hands up, or outrun them.' : 'The law has seen you. Get out of sight, or put your hands up.')
          : 'The law is searching. Get out of the red circle and stay out of sight.';
        el.law.dataset.s = !st.wanted ? 'witness' : st.flags & SS.SEEN ? 'seen' : '';
      }
    }
    // down: dead, or in jail
    const dk = a.dead ? `d${st.timer}` : st.flags & SS.JAILED ? `j${st.timer}` : '';
    if (dk !== downKey) {
      downKey = dk; el.down.hidden = !dk;
      if (dk) {
        el.down.classList.toggle('jail', !a.dead);
        el.down.querySelector('.big').textContent = a.dead ? (session.killer ? `Shot by ${session.killer}` : 'Dead') : 'In jail';
        el.down.querySelector('.small').textContent = a.dead ? (st.timer > 0 ? `Up again in ${st.timer}` : 'Getting up') : `Out in ${st.timer} s`;
      }
    }
    if (noteAt && now > noteAt) { el.note.classList.add('gone'); noteAt = 0; }
  }
  const hit = kill => restart(el.hitmark, !!kill);
  // hurt from a direction: rel is the angle of the shooter from straight ahead, clockwise, in radians
  const damage = rel => { el.dmg.style.transform = `rotate(${rel}rad)`; restart(el.dmg); };
  function note(text, now, ms = 4200) { el.note.textContent = text; el.note.hidden = false; el.note.classList.remove('gone'); noteAt = now + ms; }

  store.on((s, p) => {
    if ('showStats' in p) { el.wire.hidden = !s.showStats; el.bar.hidden = !s.showStats; el.pace.hidden = !s.showStats; }
    if ('lag' in p) el.ping.querySelector('b').textContent = s.lag ? s.lag + ' ms' : 'none';
    if ('mode' in p) el.hud.hidden = s.mode !== 'play';
  });
  return { stats, minimap, frame, combat, hit, damage, note, resetWorst() { worst = 0; }, resetPlace() { where = ''; whereAt = -1e9; }, set map(m) { map = m; }, get map() { return map; } };
}
