// What is on screen while playing: the connection panel, the radar and a line of help. In the finished game almost
// none of this will show; for Phase 2 the instruments are the point.
import { BAND_NEAR, BAND_MID, BAND_FAR, VIEW_ENTER, VIEW_LEAVE, HUB_X, HUB_Z, CHUNK, EF_BOT } from '../../../shared/constants.js';

const $ = id => document.getElementById(id);
const kb = n => (n >= 10240 ? (n / 1024).toFixed(0) : (n / 1024).toFixed(1)) + ' KB/s';

export function createHud(store) {
  const el = { hud: $('hud'), wire: $('wire'), radar: $('radar'), hint: $('hint'), pace: $('pace'), ping: $('bPing'), vals: {} };
  for (const d of el.wire.querySelectorAll('[data-k]')) el.vals[d.dataset.k] = d;
  const ctx = el.radar.getContext('2d');
  let last = null, at = 0, frames = 0, fps = 0, radarAt = 0, worst = 0;
  const set = (k, v, cls) => { const d = el.vals[k]; if (!d) return; if (d.textContent !== v) d.textContent = v; if (cls !== undefined && d.dataset.s !== cls) d.dataset.s = cls; };

  function stats(session, now, total, lag) {
    frames++;
    if (now - at < 500) return;
    const st = session.stats, dt = (now - at) / 1000; fps = frames / dt; frames = 0; at = now;
    const cur = { i: st.bytesIn, o: st.bytesOut, s: st.snapshots };
    if (last) {
      const down = (cur.i - last.i) / dt, up = (cur.o - last.o) / dt;
      set('down', kb(down), down > 16384 ? 'bad' : ''); set('up', kb(up), up > 2048 ? 'bad' : ''); set('snaps', ((cur.s - last.s) / dt).toFixed(0) + ' a second');
    }
    last = cur;
    const rtt = session.rtt, mm = st.errLast * 1000; if (mm > worst) worst = mm;
    set('ping', rtt < 1 ? 'under 1 ms' : rtt.toFixed(0) + ' ms' + (lag ? ' (added)' : ''), rtt > 250 ? 'bad' : rtt > 120 ? 'warn' : 'good');
    set('view', total ? `${session.ents.size} of ${total - 1} others` : `${session.ents.size} others`);
    set('behind', session.nearDelay.toFixed(0) + ' ms');
    set('predict', (mm < 0.005 ? '0' : mm.toFixed(2)) + ' mm now, ' + (worst < 0.005 ? '0' : worst.toFixed(2)) + ' worst', worst > 100 ? 'bad' : worst > 10 ? 'warn' : 'good');
    set('fixes', String(st.corrections), st.corrections > 5 ? 'warn' : '');
    set('ahead', ((session.seq - session.ack - 1) & 65535) + ' inputs');
    set('fps', fps.toFixed(0) + ' a second', fps < 45 ? 'bad' : fps < 57 ? 'warn' : 'good');
    const m = session.me, cx = Math.floor(m.x / CHUNK), cz = Math.floor(m.z / CHUNK), d = Math.hypot(m.x - HUB_X, m.z - HUB_Z);
    set('where', `${d.toFixed(0)} m from the hub, square ${cx}.${cz}`);
  }

  // heading-up radar on a square-root scale, so the 60 m ring is not a dot in the middle
  function radar(session, yaw, now) {
    if (now - radarAt < 90) return; radarAt = now;
    const cv = el.radar, dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth; if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = cv.height = Math.round(w * dpr); }
    const R = cv.width / 2, css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
    const px = d => Math.sqrt(Math.min(d, VIEW_LEAVE) / VIEW_LEAVE) * (R - 2 * dpr);
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.save(); ctx.translate(R, R);
    ctx.lineWidth = dpr; ctx.font = `${10 * dpr}px ${col('--text')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const [d, key, label] of [[BAND_NEAR, '--near', '60'], [BAND_MID, '--mid', '150'], [VIEW_ENTER, '--far', '384 m']]) {
      ctx.strokeStyle = col(key); ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.arc(0, 0, px(d), 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 0.9; ctx.fillStyle = col(key); ctx.fillText(label, 4 * dpr, -px(d) + 7 * dpr);
    }
    ctx.globalAlpha = 1;
    // north: forward is (-sin yaw, -cos yaw), and forward is up the screen
    const sy = Math.sin(yaw), cy = Math.cos(yaw), nx = -sy * (R - 9 * dpr), ny = -cy * (R - 9 * dpr);
    ctx.fillStyle = col('--dim'); ctx.textAlign = 'center'; ctx.fillText('N', nx, ny);
    for (const e of session.ents.values()) {
      const dx = e.x - session.x, dz = e.z - session.z, d = Math.hypot(dx, dz); if (d < 0.01) continue;
      // into view space: right = (cos yaw, -sin yaw), forward = (-sin yaw, -cos yaw)
      const rx = dx * cy - dz * sy, fz = -dx * sy - dz * cy, k = px(d) / d, bot = (e.ef & EF_BOT) !== 0;
      ctx.fillStyle = col(d < BAND_NEAR ? '--near' : d < BAND_MID ? '--mid' : d < BAND_FAR ? '--far' : '--edge');
      ctx.beginPath(); ctx.arc(rx * k, -fz * k, (bot ? 2.1 : 3.4) * dpr, 0, 6.2832); ctx.fill();
      if (!bot) { ctx.strokeStyle = col('--ink'); ctx.stroke(); }
    }
    ctx.fillStyle = col('--ink'); ctx.beginPath(); ctx.moveTo(0, -6 * dpr); ctx.lineTo(4.5 * dpr, 5 * dpr); ctx.lineTo(-4.5 * dpr, 5 * dpr); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function pace(session, intent) {
    const m = session.me, sp = Math.hypot(m.vx, m.vz);
    const t = !m.ground ? 'In the air' : sp < 0.1 ? 'Standing' : sp < 2.2 ? 'Walk' : sp < 4.6 ? 'Jog' : 'Sprint';
    const text = `${t} · ${sp.toFixed(1)} m/s` + (intent.walk ? ' · walking pace held' : '');
    if (el.pace.textContent !== text) el.pace.textContent = text;
    if (intent.moved && !el.hint.classList.contains('gone')) el.hint.classList.add('gone');
  }
  store.on((s, p) => { if ('showStats' in p) { el.wire.hidden = !s.showStats; } if ('lag' in p) el.ping.querySelector('b').textContent = s.lag ? s.lag + ' ms' : 'none'; if ('mode' in p) el.hud.hidden = s.mode !== 'play'; });
  return { stats, radar, pace, resetWorst() { worst = 0; } };
}
