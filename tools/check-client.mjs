// Opens the built page in a real (headless) browser, walks about, and saves screenshots. A smoke test for the
// client, as HoodWar has: it fails if the page logs an error, the session does not start, or prediction and the
// server disagree.
//   node tools/check-client.mjs [--artifact] [--phone] [--url ws://127.0.0.1:8080]
//
// Headless browsers draw in software, and this scene runs at a few frames a second that way. So the netcode is
// checked with the scenery switched off (the page then runs at a normal rate), and the screenshots are taken after.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), { chromium, devices } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2), OUT = resolve(ROOT, 'tools/out');
const artifact = args.includes('--artifact'), phone = args.includes('--phone'), url = args.includes('--url') ? args[args.indexOf('--url') + 1] : '';
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
await page.goto(pathToFileURL(file).href + (url ? '?server=' + encodeURIComponent(url) : ''));
await page.waitForFunction(() => globalThis.__ct && __ct.session && __ct.session.state === 'playing' && __ct.session.ents.size > 5 && __ct.camera, null, { timeout: 20000 });
const shot = async name => { await page.screenshot({ path: resolve(OUT, `${tag}-${name}.png`) }); };
const scenery = on => page.evaluate(on => { for (const m of __ct.view.scene.children) if (m.isMesh && !m.isInstancedMesh) m.visible = on; }, on);
const wait = ms => page.waitForTimeout(ms);
let touch = null;
if (phone) { const cdp = await ctx.newCDPSession(page); touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts }); }

await wait(2500); await shot('1-title');
if (!url) { if (phone) await page.tap('#play'); else await page.click('#play'); }

// ---- netcode, at a normal frame rate
await scenery(false); await wait(800);
const base = await page.evaluate(() => { const st = __ct.session.stats; st.errMax = 0; return { frames: __ct.frames, t: performance.now(), corrections: st.corrections, snapshots: st.snapshots, x: __ct.session.me.x, z: __ct.session.me.z }; });
if (phone) {
  await touch('touchStart', [{ x: 90, y: 620, id: 1 }]); await touch('touchMove', [{ x: 90, y: 556, id: 1 }]); await wait(2500);
  await touch('touchStart', [{ x: 90, y: 556, id: 1 }, { x: 300, y: 400, id: 2 }]); await touch('touchMove', [{ x: 90, y: 556, id: 1 }, { x: 240, y: 410, id: 2 }]); await wait(1500);
  await page.tap('#bPing'); await page.tap('#bPing'); await wait(3500);
} else {
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await wait(2500);
  await page.keyboard.down('KeyA'); await wait(700); await page.keyboard.up('KeyA'); await page.keyboard.press('Space'); await wait(600);
  await page.keyboard.press('KeyL'); await page.keyboard.press('KeyL');                        // 150 ms of ping
  await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.move(520, 372, { steps: 12 }); await page.mouse.up();
  await wait(3500); await page.keyboard.press('Space'); await wait(500);
}
const r = await page.evaluate(b => {
  const s = __ct.session, st = s.stats, m = s.me;
  return { fps: Math.round((__ct.frames - b.frames) / (performance.now() - b.t) * 10000) / 10, state: s.state, mode: __ct.store.state.mode, ownThread: __ct.local ? __ct.local.threaded : null,
    others: s.ents.size, inWorld: __ct.local ? __ct.local.total : null, snapshots: st.snapshots - b.snapshots, corrections: st.corrections - b.corrections, errMaxMm: st.errMax * 1000, pingMs: Math.round(s.rtt), addedPing: __ct.store.state.lag,
    moved: Math.round(Math.hypot(m.x - b.x, m.z - b.z) * 10) / 10, speed: Math.round(Math.hypot(m.vx, m.vz) * 10) / 10, drawn: __ct.view.scene.children.filter(c => c.isInstancedMesh).map(c => c.count) };
}, base);

// ---- pictures
await scenery(true); await wait(3000); await shot(phone ? '2-walking' : '2-sprinting-150ms');
if (phone) await touch('touchEnd', []);
else { await page.keyboard.press('KeyB'); await wait(2500); await shot('3-range-colours'); await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft'); }
const info = await page.evaluate(() => ({ calls: __ct.view.renderer.info.render.calls, triangles: __ct.view.renderer.info.render.triangles }));
console.log(tag, JSON.stringify({ ...r, ...info }), errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno page errors');
await browser.close();
const bad = errors.length || r.state !== 'playing' || r.mode !== 'play' || r.others < 5 || r.moved < 3 || r.errMaxMm > 0 || r.corrections > 0 || (!url && r.addedPing !== 150);
if (bad) console.log('CHECK FAILED');
process.exit(bad ? 1 : 0);
