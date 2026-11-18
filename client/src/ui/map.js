// The map: the whole territory from above, painted from the same ground colours the terrain uses, with the roads,
// the river, the buildings and the names of places laid over it in the manner of a surveyor's sheet. The same image
// turns under the round map in the corner; M opens it full size.
import { WORLD_SIZE, KIND_HORSE, EF_BOT } from '../../../shared/constants.js';
import { REGIONS, clockText } from './hud.js';

// one pixel for every four metres, lit from the north-west so the hills stand up
export function makeMapImage(field, terrain) {
  const cv = document.createElement('canvas'); terrain.paintMap(cv);
  const ctx = cv.getContext('2d'), k = cv.width / WORLD_SIZE;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // roads: a dark edge and a pale middle
  for (const [w, c] of [[3.2, 'rgba(70,52,34,0.55)'], [1.6, 'rgba(232,214,176,0.95)']]) {
    ctx.lineWidth = w; ctx.strokeStyle = c;
    for (const r of field.terrain.roads) { ctx.beginPath(); ctx.moveTo(r.x[0] * k, r.z[0] * k); for (let i = 1; i < r.n; i++) ctx.lineTo(r.x[i] * k, r.z[i] * k); ctx.stroke(); }
  }
  // buildings, and the bridge
  ctx.fillStyle = 'rgba(52,38,28,0.95)';
  for (const b of field.buildings) ctx.fillRect(b.x0 * k, b.z0 * k, Math.max(1, (b.x1 - b.x0) * k), Math.max(1, (b.z1 - b.z0) * k));
  if (field.bridge) { const b = field.bridge; ctx.fillStyle = 'rgba(110,84,58,1)'; ctx.fillRect(b.x0 * k, b.z0 * k, (b.x1 - b.x0) * k, Math.max(1.5, (b.z1 - b.z0) * k)); }
  cv.mpp = WORLD_SIZE / cv.width;
  return cv;
}

export function createMap(store, field, image) {
  const box = document.getElementById('map'), cv = document.getElementById('mapCanvas'), ctx = cv.getContext('2d');
  let open = false, zoom = 1, cx = WORLD_SIZE / 2, cz = WORLD_SIZE / 2, follow = true, drag = null;
  const labels = [
    ...field.places.map(p => ({ x: p.x, z: p.z - (p.r + 14), text: p.name, kind: p.kind === 'town' ? 'town' : 'camp' })),
    { x: 1030, z: 980, text: REGIONS.mount, kind: 'region' }, { x: 2300, z: 230, text: REGIONS.north, kind: 'region' }, { x: 3330, z: 3400, text: REGIONS.swamp, kind: 'region' },
    { x: 700, z: 3420, text: REGIONS.desert, kind: 'region' }, { x: 3120, z: 2250, text: REGIONS.plains, kind: 'region' }, { x: 1240, z: 2120, text: REGIONS.forest, kind: 'region' },
    { x: 1925, z: 1120, text: 'Calder River', kind: 'water' },
  ];
  function draw(session, hour, yaw) {
    const dpr = Math.min(devicePixelRatio || 1, 2), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const fit = Math.min(cv.width, cv.height) / WORLD_SIZE * 0.96, s = fit * zoom;
    if (follow && session) { cx = session.x; cz = session.z; }
    // the middle of the view: the whole map at zoom 1, otherwise following you (or where you dragged it), kept on the map
    const centre = (c, span) => (span >= WORLD_SIZE ? WORLD_SIZE / 2 : Math.min(WORLD_SIZE - span / 2, Math.max(span / 2, c)));
    const vx = zoom > 1 ? centre(cx, cv.width / s) : WORLD_SIZE / 2, vz = zoom > 1 ? centre(cz, cv.height / s) : WORLD_SIZE / 2;
    const ox = cv.width / 2 - vx * s, oz = cv.height / 2 - vz * s;
    const X = x => ox + x * s, Z = z => oz + z * s;
    ctx.fillStyle = '#1b1712'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = zoom < 2.5; ctx.drawImage(image, ox, oz, WORLD_SIZE * s, WORLD_SIZE * s);
    ctx.strokeStyle = 'rgba(29,22,11,0.9)'; ctx.lineWidth = 2 * dpr; ctx.strokeRect(ox, oz, WORLD_SIZE * s, WORLD_SIZE * s);
    // a faint survey grid every kilometre
    ctx.strokeStyle = 'rgba(29,22,11,0.18)'; ctx.lineWidth = dpr;
    for (let v = 1024; v < WORLD_SIZE; v += 1024) { ctx.beginPath(); ctx.moveTo(X(v), Z(0)); ctx.lineTo(X(v), Z(WORLD_SIZE)); ctx.moveTo(X(0), Z(v)); ctx.lineTo(X(WORLD_SIZE), Z(v)); ctx.stroke(); }
    // names
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const l of labels) {
      const big = l.kind === 'town', region = l.kind === 'region', water = l.kind === 'water';
      const fs = (region ? 15 : big ? 15 : water ? 12 : 12) * dpr * Math.min(1.6, 0.85 + zoom * 0.15);
      ctx.font = `${region || water ? 'italic 500' : big ? '800' : '600'} ${fs}px Besley, Georgia, serif`;
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(239,230,210,0.85)'; ctx.fillStyle = region ? 'rgba(52,38,28,0.82)' : water ? '#2c5260' : '#1d160b';
      const text = region ? l.text.toUpperCase().split('').join(' ') : l.text;
      ctx.strokeText(text, X(l.x), Z(l.z)); ctx.fillText(text, X(l.x), Z(l.z));
      if (!region && !water) { ctx.beginPath(); ctx.arc(X(l.x), Z(l.z + 18), (big ? 4 : 3) * dpr, 0, 6.2832); ctx.fillStyle = '#1d160b'; ctx.fill(); }
    }
    if (!session) return;
    // other people, your horse, you
    for (const e of session.ents.values()) if (!(e.ef & EF_BOT) && e.kind !== KIND_HORSE) { ctx.beginPath(); ctx.arc(X(e.x), Z(e.z), 4 * dpr, 0, 6.2832); ctx.fillStyle = '#f1ead8'; ctx.fill(); ctx.strokeStyle = '#1d160b'; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
    const a = session.a;
    if (a.h && !a.riding) { ctx.beginPath(); ctx.arc(X(session.horse.x), Z(session.horse.z), 5.5 * dpr, 0, 6.2832); ctx.fillStyle = '#dba64c'; ctx.fill(); ctx.strokeStyle = '#1d160b'; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
    ctx.save(); ctx.translate(X(session.x), Z(session.z)); ctx.rotate(-yaw);
    ctx.beginPath(); ctx.moveTo(0, -11 * dpr); ctx.lineTo(7.5 * dpr, 8 * dpr); ctx.lineTo(0, 4 * dpr); ctx.lineTo(-7.5 * dpr, 8 * dpr); ctx.closePath();
    ctx.fillStyle = '#b5483a'; ctx.fill(); ctx.strokeStyle = '#f1ead8'; ctx.lineWidth = 2 * dpr; ctx.stroke(); ctx.restore();
    document.getElementById('mapTime').textContent = clockText(hour);
  }
  const show = v => { open = v; box.hidden = !v; if (v) { zoom = 1; follow = true; } };
  store.on((s, p) => { if ('mode' in p && s.mode !== 'play') show(false); });
  cv.addEventListener('wheel', e => { e.preventDefault(); zoom = Math.min(6, Math.max(1, zoom * (e.deltaY < 0 ? 1.25 : 0.8))); }, { passive: false });
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx, cz }; follow = false; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (!drag) return; const s = Math.min(cv.clientWidth, cv.clientHeight) / WORLD_SIZE * 0.96 * zoom; cx = drag.cx - (e.clientX - drag.x) / s; cz = drag.cz - (e.clientY - drag.y) / s; });
  cv.addEventListener('pointerup', () => { drag = null; });
  document.getElementById('mapZoomIn').addEventListener('click', () => { zoom = Math.min(6, zoom * 1.6); });
  document.getElementById('mapZoomOut').addEventListener('click', () => { zoom = Math.max(1, zoom / 1.6); if (zoom === 1) follow = true; });
  document.getElementById('mapClose').addEventListener('click', () => show(false));
  return { image, get open() { return open; }, toggle() { show(!open); }, close() { show(false); }, draw };
}
