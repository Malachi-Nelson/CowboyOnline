// Opens the built page in a real (headless) browser, plays it, and saves screenshots. A smoke test for the client,
// as HoodWar has: it fails if the page logs an error, the session does not start, the horse does not come when
// whistled for, or prediction and the server disagree.
//   node tools/check-client.mjs [--artifact] [--phone] [--url ws://127.0.0.1:8080] [--tour]
//
// Headless browsers draw in software, at a few frames a second here. So the play is done with the scene switched
// off (the page then runs at a normal rate), and the pictures are taken after, holding still. --tour also takes
// pictures around the territory and at night.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), { chromium, devices } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2), OUT = resolve(ROOT, 'tools/out');
const artifact = args.includes('--artifact'), phone = args.includes('--phone'), tour = args.includes('--tour'), url = args.includes('--url') ? args[args.indexOf('--url') + 1] : '';
const hour = args.includes('--hour') ? args[args.indexOf('--hour') + 1] : '';
mkdirSync(OUT, { recursive: true });
let file = resolve(ROOT, 'client/dist/index.html');
if (artifact) {                                   // wrap the fragment the way the preview host does
  file = resolve(OUT, 'artifact-wrapped.html');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${readFileSync(resolve(ROOT, 'client/dist/artifact.html'), 'utf8')}</body></html>`);
}
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage(), errors = [], tag = (artifact ? 'artifact-' : '') + (phone ? 'phone' : 'desktop');
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = undefined; });   // automation reports nonsense deltas under pointer lock; test drag-to-look
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.route('**/three.min.js', r => r.fulfill({ path: resolve(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'application/javascript' }));
await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
const q = new URLSearchParams(); if (url) q.set('server', url); if (hour) q.set('hour', hour);
await page.goto(pathToFileURL(file).href + (q.toString() ? '?' + q : ''));
await page.waitForFunction(() => globalThis.__ct && __ct.session && __ct.session.state === 'playing' && __ct.session.ents.size > 5 && __ct.world && __ct.camera, null, { timeout: 60000 });
const shot = async name => { await page.screenshot({ path: resolve(OUT, `${tag}-${name}.png`) }); console.log('  saved', `${tag}-${name}.png`); };
const scenery = on => page.evaluate(on => { __ct.view.scene.visible = on; }, on);
const wait = ms => page.waitForTimeout(ms);
const state = () => page.evaluate(() => { const s = __ct.session, a = s.a, h = a.h; return { riding: a.riding, horse: Math.round(Math.hypot(h.x - a.f.x, h.z - a.f.z) * 10) / 10, mode: h.mode, sp: Math.round(h.sp * 10) / 10, stam: Math.round(h.stam * 100) / 100, x: Math.round(a.f.x), z: Math.round(a.f.z), corrections: s.stats.corrections, errMaxMm: s.stats.errMax * 1000 }; });
const info0 = await page.evaluate(() => ({ buildMs: __ct.world.ms, threaded: __ct.local ? __ct.local.threaded : null }));
let touch = null;
if (phone) { const cdp = await ctx.newCDPSession(page); touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts }); }

await wait(3500); await shot('1-title');
if (!url) { if (phone) await page.tap('#play'); else await page.click('#play'); }
await wait(2500); await shot('2-main-street');

// ---- play, at a normal frame rate
await scenery(false); await wait(800);
await page.evaluate(() => { const st = __ct.session.stats; st.errMax = 0; });
const log = [];
const press = async (k, ms = 120) => { await page.keyboard.down(k); await wait(ms); await page.keyboard.up(k); };
if (phone) {
  await touch('touchStart', [{ x: 90, y: 620, id: 1 }]); await touch('touchMove', [{ x: 90, y: 556, id: 1 }]); await wait(2500); await touch('touchEnd', []);
  log.push(['walked away', await state()]);
  await page.tap('#tWhistle'); await wait(6000); log.push(['whistled', await state()]);
  await page.tap('#tUse'); await wait(600); log.push(['mounted', await state()]);
  await page.tap('#tRun'); await touch('touchStart', [{ x: 90, y: 620, id: 1 }]); await touch('touchMove', [{ x: 90, y: 556, id: 1 }]); await wait(4000); await touch('touchEnd', []); log.push(['galloped', await state()]);
  await page.tap('#bPing').catch(() => {});
} else {
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await wait(2200); await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
  await wait(600); log.push(['walked away', await state()]);
  await press('KeyH'); await wait(6000); log.push(['whistled', await state()]);
  await press('KeyE'); await wait(500); log.push(['mounted', await state()]);
  await page.evaluate(() => { __ct.controls.intent.yaw = -Math.PI / 2; });                     // look east, down the street to the bridge
  await page.keyboard.press('KeyL');                                                           // 150 ms of ping
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await wait(4500); log.push(['galloping, 150 ms ping', await state()]);
  await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.move(628, 362, { steps: 6 }); await page.mouse.up();
  await wait(2000); await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS'); await wait(3500); await page.keyboard.up('KeyS'); log.push(['reined in', await state()]);
  await press('KeyE'); await wait(800); log.push(['stepped down', await state()]);
  await press('KeyE'); await wait(600); log.push(['back up', await state()]);
}
const r = await page.evaluate(() => {
  const s = __ct.session, st = s.stats;
  return { state: s.state, mode: __ct.store.state.mode, others: s.ents.size, inWorld: __ct.local ? __ct.local.total : null, snapshots: st.snapshots, corrections: st.corrections, errMaxMm: st.errMax * 1000, pingMs: Math.round(s.rtt), addedPing: __ct.store.state.lag, hour: Math.round(s.hour() * 100) / 100 };
});
for (const [what, s] of log) console.log(' ', what.padEnd(24), JSON.stringify(s));

// ---- pictures
await scenery(true);
if (!phone) { await page.keyboard.down('KeyW'); await wait(2500); }
await shot(phone ? '3-riding' : '3-riding-150ms');
if (!phone) await page.keyboard.up('KeyW');
await page.keyboard.press('KeyM'); await wait(2500); await shot('4-map'); await page.keyboard.press('KeyM'); await wait(300);
const info = await page.evaluate(() => ({ calls: __ct.view.renderer.info.render.calls, triangles: __ct.view.renderer.info.render.triangles, trees: __ct.world.trees.drawn, towns: __ct.world.towns.triangles }));
if (tour) {
  // fixed cameras around the territory: [name, camera x y z, looking at x y z]
  const T = await page.evaluate(() => { const f = __ct.session.field, t = f.terrain, h = (x, z) => t.heightAt(x, z); const r = t.river, bx = r.x[r.iHub]; const P = n => f.places.find(p => p.id === n);
    return [
      ['street', 1925, f.base + 2.2, 2052, 2020, f.base + 4, 2046], ['bridge', bx - 40, f.base + 7, 2080, bx + 10, f.base, 2048],
      ['timber', P('timber').x + 60, P('timber').y + 14, P('timber').z + 50, P('timber').x - 10, P('timber').y + 4, P('timber').z],
      ['mountains', 1500, h(1500, 1500) + 30, 1500, 900, h(900, 900) + 60, 900], ['high-country', P('lantern').x + 70, P('lantern').y + 16, P('lantern').z + 70, P('lantern').x, P('lantern').y + 4, P('lantern').z],
      ['mirewood', P('mirewood').x + 75, 34, P('mirewood').z + 75, P('mirewood').x, 13, P('mirewood').z], ['dry-fork', P('dryfork').x + 70, P('dryfork').y + 14, P('dryfork').z + 50, P('dryfork').x - 10, P('dryfork').y + 4, P('dryfork').z],
      ['canyon', 560, h(560, 3020) + 34, 2950, 620, h(620, 3330), 3330], ['ranch', P('ranch').x + 70, P('ranch').y + 16, P('ranch').z + 70, P('ranch').x, P('ranch').y + 3, P('ranch').z + 10],
    ]; });
  for (const [name, ...p] of T) { await page.evaluate(p => __ct.photo(p), p); await wait(5500); await shot('tour-' + name); }
  // you and your horse, up close; then the same street at dusk, at night, and in the rain
  await page.evaluate(() => { const s = __ct.session, h = s.horse, a = Math.atan2(-Math.sin(h.yaw), -Math.cos(h.yaw)); __ct.photo([h.x + Math.cos(h.yaw) * 4.2 + Math.sin(h.yaw) * 2.2, h.y + 2.3, h.z - Math.sin(h.yaw) * 4.2 + Math.cos(h.yaw) * 2.2, h.x, h.y + 1.3, h.z]); void a; });
  await wait(5000); await shot('tour-closeup');
  const st = [1940, (await page.evaluate(() => __ct.session.field.base)) + 2.4, 2051, 2040, (await page.evaluate(() => __ct.session.field.base)) + 4.5, 2045];
  for (const [name, o] of [['dusk', { hour: 18.4 }], ['night', { hour: 22 }], ['rain', { hour: 11, weather: { cloud: 1, rain: 1, snow: 0, mist: 0.6 } }]]) {
    await page.evaluate(([p, o]) => { __ct.photo(p); __ct.force(o); }, [st, o]); await wait(5500); await shot('tour-' + name);
  }
  await page.evaluate(() => { __ct.photo(null); __ct.force({ hour: undefined, weather: undefined }); });
}
console.log(tag, JSON.stringify({ ...r, ...info0, ...info }), errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno page errors');
await browser.close();
const L = Object.fromEntries(log);
const came = L.whistled && L.whistled.horse < 3, mounted = L.mounted && L.mounted.riding === 1, rode = phone ? L.galloped && L.galloped.sp > 5 : L['galloping, 150 ms ping'] && L['galloping, 150 ms ping'].sp > 9;
const down = phone || (L['stepped down'] && L['stepped down'].riding === 0 && L['back up'].riding === 1);
const bad = errors.length || r.state !== 'playing' || r.mode !== 'play' || r.others < 5 || !came || !mounted || !rode || !down || r.errMaxMm > 0 || r.corrections > 0 || (!url && !phone && r.addedPing !== 150);
if (bad) console.log('CHECK FAILED', JSON.stringify({ came, mounted, rode, down }));
process.exit(bad ? 1 : 0);
