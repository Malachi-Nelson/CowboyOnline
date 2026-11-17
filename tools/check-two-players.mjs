// Two real browser pages in one hosted world: starts the Node server, joins both pages to it over WebSockets, walks
// one of them about and checks that the other sees a named, moving person. Saves a picture from each side.
//   node tools/check-two-players.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), OUT = resolve(ROOT, 'tools/out'), PORT = 18555;
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [resolve(ROOT, 'server/src/node/main.js')], { env: { ...process.env, PORT: String(PORT), BOTS: '12' }, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch (e) { /* not up yet */ } await new Promise(r => setTimeout(r, 50)); }

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const errors = [];
async function join(name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 }), page = await ctx.newPage();
  await page.addInitScript(n => { HTMLCanvasElement.prototype.requestPointerLock = undefined; try { localStorage.setItem('calder.name', JSON.stringify(n)); } catch (e) { /* no storage */ } }, name);
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name}: ${e}`));
  await page.route('**/three.min.js', r => r.fulfill({ path: resolve(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'application/javascript' }));
  await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.goto(pathToFileURL(resolve(ROOT, 'client/dist/index.html')).href + '?server=' + encodeURIComponent(`ws://127.0.0.1:${PORT}`));
  await page.waitForFunction(() => globalThis.__ct && __ct.session && __ct.session.state === 'playing' && __ct.camera, null, { timeout: 20000 });
  await page.evaluate(() => { for (const m of __ct.view.scene.children) if (m.isMesh && !m.isInstancedMesh) m.visible = false; });   // scenery off: software drawing is slow
  return page;
}
const ada = await join('Ada'), boone = await join('Boone');
await ada.waitForTimeout(1500);
const seen = () => boone.evaluate(() => { const e = [...__ct.session.ents.values()].find(e => !(e.ef & 1)); return e ? { name: e.name, x: e.x, z: e.z, d: Math.hypot(e.x - __ct.session.x, e.z - __ct.session.z) } : null; });
const before = await seen();
// Boone turns to face Ada so the picture has her in it; Ada jogs in a rough circle
await boone.evaluate(() => { const s = __ct.session, e = [...s.ents.values()].find(e => !(e.ef & 1)); if (e) __ct.controls.intent.yaw = Math.atan2(-(e.x - s.x), -(e.z - s.z)); });
await ada.keyboard.down('KeyW'); await ada.waitForTimeout(1200); await ada.keyboard.down('KeyD'); await ada.waitForTimeout(1500); await ada.keyboard.up('KeyD'); await ada.waitForTimeout(800);
const after = await seen();
const stats = async p => p.evaluate(() => { const s = __ct.session, st = s.stats; return { id: s.id, others: s.ents.size, people: [...s.ents.values()].filter(e => !(e.ef & 1)).map(e => e.name), corrections: st.corrections, errMaxMm: st.errMax * 1000, ping: Math.round(s.rtt), tags: document.querySelectorAll('#tags span:not([hidden])').length }; });
const A = await stats(ada), B = await stats(boone);
for (const p of [ada, boone]) await p.evaluate(() => { for (const m of __ct.view.scene.children) m.visible = true; });
await boone.evaluate(() => { const s = __ct.session, e = [...s.ents.values()].find(e => !(e.ef & 1)); if (e) __ct.controls.intent.yaw = Math.atan2(-(e.x - s.x), -(e.z - s.z)); });
await ada.keyboard.up('KeyW'); await boone.waitForTimeout(4000);
await boone.screenshot({ path: resolve(OUT, 'two-players-boone-sees-ada.png') }); await ada.screenshot({ path: resolve(OUT, 'two-players-ada.png') });
const status = await (await fetch(`http://127.0.0.1:${PORT}/status`)).json();
const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 0;
console.log(JSON.stringify({ ada: A, boone: B, booneSaw: before && before.name, adaMovedOnBoonesScreen: Math.round(moved * 10) / 10, server: { people: status.people, bots: status.bots, tickP99: status.tickMs.p99 } }), errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nno page errors');
await browser.close(); server.kill('SIGTERM');
const bad = errors.length || !before || before.name !== 'Ada' || moved < 3 || A.people[0] !== 'Boone' || status.people !== 2 || A.errMaxMm > 0 || B.errMaxMm > 0;
if (bad) console.log('CHECK FAILED');
process.exit(bad ? 1 : 0);
