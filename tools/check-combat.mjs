// Pictures of Phase 4 for the README, taken in a headless browser that draws in software: a jump, a shot on the main
// street, Iron Nerve with marks on two townsfolk, hands up as a lawman comes to take you in, and the cell. It also fails on any page error, so
// it doubles as a check of the whole crime-to-jail path in the real page.
//   node tools/check-combat.mjs [--out dir]
// Needs Playwright, like check-client.mjs.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url), { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const OUT = resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'tools/out');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await ctx.newPage(), errors = [];
await page.addInitScript(() => { HTMLCanvasElement.prototype.requestPointerLock = undefined; });
page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/three.min.js', r => r.fulfill({ path: resolve(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'application/javascript' }));
await page.route('**fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
await page.goto(pathToFileURL(resolve(ROOT, 'client/dist/index.html')).href + '?bots=40&hour=16.5');
await page.waitForFunction(() => globalThis.__ct && __ct.session && __ct.session.state === 'playing' && __ct.world && __ct.camera, null, { timeout: 60000 });
const wait = ms => page.waitForTimeout(ms);
const press = async (k, ms = 120) => { await page.keyboard.down(k); await wait(ms); await page.keyboard.up(k); };
const scene = on => page.evaluate(on => { __ct.view.scene.visible = on; }, on);
const shot = async name => { await page.screenshot({ path: resolve(OUT, `combat-${name}.png`) }); console.log('  saved', `combat-${name}.png`); };
const state = () => page.evaluate(() => { const s = __ct.session, st = s.status; return { hp: st.hp, wanted: st.wanted, bounty: st.bounty, seen: !!(st.flags & 4), jailed: !!(st.flags & 2), dead: s.a.dead, shots: s.a.shots, hits: s.stats.hitsMade || 0, corrections: s.stats.corrections, lawmenInView: [...s.ents.values()].filter(e => e.ef & 2).length, witnesses: [...s.ents.values()].filter(e => e.gear & 64).length }; });
// hold still on the frame where `cond` (a function of the session, as source text) first holds, take the picture, let go
const hold = async (cond, name, timeout = 15000) => {
  await page.evaluate(c => __ct.hold(eval(c)), cond);
  const ok = await page.waitForFunction(() => __ct.holding, null, { timeout }).then(() => true).catch(() => false);
  if (ok) await shot(name); else console.log('  missed', name);
  await page.evaluate(() => __ct.hold(null));
  return ok;
};
// turn the view so the shot line goes through the nearest townsman (not a lawman, not dead, not riding), skipping `not`;
// one standing still if there is one within 30 m, since a man walking across the sights is easy to miss
// cone: only someone within that many radians of the way the street runs west (for a picture with the street in it)
const sightNearest = (not = [], cone = 0) => page.evaluate(([not, cone]) => {
  const s = __ct.session; let best = null, bd = 1e9;
  for (const e of s.ents.values()) {
    if (e.kind !== 1 || e.gear & 32 || e.ef & 2 || !(e.ef & 1) || e.st & 8 || not.includes(e.id)) continue;
    if (cone && Math.abs(Math.atan2(e.z - s.z, s.x - e.x)) > cone) continue;
    const d = Math.hypot(e.x - s.x, e.z - s.z) + (e.st & 4 ? 30 : 0); if (d > 6 && d < bd) { bd = d; best = e; }
  }
  if (!best) return null;
  const i = __ct.controls.intent; let yaw = i.yaw, pitch = 0;
  const tx = best.x + (best.vx || 0) * 0.12, tz = best.z + (best.vz || 0) * 0.12;   // a little ahead of a moving man: the trigger is read a frame or two later
  for (let k = 0; k < 4; k++) { const ox = s.a.f.x + Math.cos(yaw) * 0.72, oy = s.a.f.y + 1.7, oz = s.a.f.z - Math.sin(yaw) * 0.72, dx = tx - ox, dy = best.y + 1.15 - oy, dz = tz - oz; yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz)); }
  i.yaw = yaw; i.pitch = pitch; return best.id;
}, [not, cone]);
const click = async () => { await page.mouse.down({ button: 'left' }); await wait(50); await page.mouse.up({ button: 'left' }); };

await page.click('#play'); await wait(1200); await scene(false);
await page.mouse.move(640, 360);

// ---- west up the main street, toward the sheriff's office
await page.evaluate(() => { __ct.controls.intent.yaw = Math.PI / 2; __ct.controls.intent.pitch = -0.05; });
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await wait(4500); await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW'); await wait(500);

// ---- draw and aim, then Iron Nerve before anyone is looking for her: two marks made with the scene hidden (drawn
// in software, a full frame takes long enough for the world to think the player has gone quiet), then two frames
// drawn and held for the picture, then the marks fired
await page.evaluate(() => { __ct.controls.intent.yaw = Math.PI / 2; __ct.controls.intent.pitch = -0.05; });
await press('Digit1'); await wait(700);
await page.mouse.down({ button: 'right' }); await wait(600);
await press('KeyQ'); await wait(300);
const nMarks = () => page.evaluate(() => [...document.querySelectorAll('#marks span')].filter(x => !x.hidden).length);
let a1 = null, a2 = null;
// a mark is taken along the camera's line, and the camera turns to the aim on the next frame drawn: let it
for (let i = 0; i < 4 && (await nMarks()) < 1; i++) { a1 = await sightNearest([], 0.6); await wait(60); await click(); await wait(250); }
for (let i = 0; i < 4 && (await nMarks()) < 2; i++) { a2 = await sightNearest([a1], 0.6); await wait(60); await click(); await wait(250); }
const marked = await page.evaluate(() => ({ nerve: document.documentElement.classList.contains('nerve'), marks: [...document.querySelectorAll('#marks span')].filter(x => !x.hidden).length }));
await page.evaluate(() => { let k = 0; __ct.hold(() => ++k > 2); }); await scene(true);
if (await page.waitForFunction(() => __ct.holding, null, { timeout: 15000 }).then(() => true).catch(() => false)) await shot('iron-nerve'); else console.log('  missed iron nerve');
await page.evaluate(() => __ct.hold(null)); await scene(false);
await press('KeyQ'); await wait(2500);
console.log('  after Iron Nerve', JSON.stringify(await state()), 'marked', a1, a2, JSON.stringify(marked));

// ---- one more shot, held at the moment it is fired; then the gun comes down
await press('KeyR'); await wait(1500);
const first = await sightNearest(); await scene(true); await wait(1500); await sightNearest();
await page.evaluate(() => { const n0 = __ct.session.a.shots; __ct.hold(s => s.a.shots !== n0); });
await click();
if (await page.waitForFunction(() => __ct.holding, null, { timeout: 15000 }).then(() => true).catch(() => false)) await shot('fire'); else console.log('  missed fire');
await page.evaluate(() => __ct.hold(null)); await scene(false); await wait(1200);
for (let i = 0; i < 4 && !(await state()).hits; i++) { await sightNearest(); await click(); await wait(900); }
console.log('  after the shot', JSON.stringify(await state()), 'at', first);
await page.mouse.up({ button: 'right' }); await press('Digit1'); await wait(500);

// ---- hands up as soon as the law knows, and a picture when a lawman comes to take her in
let st = await state();
for (let i = 0; i < 25 && !st.wanted; i++) { await wait(1000); st = await state(); }
await page.keyboard.down('KeyX');
const nearLaw = () => page.evaluate(() => { const s = __ct.session; let d = 1e9, at = null; for (const e of s.ents.values()) if (e.ef & 2 && e.kind === 1) { const k = Math.hypot(e.x - s.x, e.z - s.z); if (k < d) { d = k; at = [e.x, e.y, e.z]; } } return { d, at }; });
let law = await nearLaw();
for (let i = 0; i < 60 && law.d > 6 && !(st = await state()).jailed && !st.dead; i++) { await wait(500); law = await nearLaw(); }
if (law.d <= 6) {
  await page.evaluate(L => { const s = __ct.session, mx = (s.x + L[0]) / 2, mz = (s.z + L[2]) / 2, dx = L[0] - s.x, dz = L[2] - s.z, l = Math.hypot(dx, dz) || 1; __ct.photo([mx - dz / l * 6.5, s.a.f.y + 2.2, mz + dx / l * 6.5, mx, s.a.f.y + 1.2, mz]); }, law.at);
  await page.evaluate(() => { let k = 0; __ct.hold(() => ++k > 2); }); await scene(true);
  if (await page.waitForFunction(() => __ct.holding, null, { timeout: 15000 }).then(() => true).catch(() => false)) await shot('hands-up'); else console.log('  missed hands up');
  await page.evaluate(() => { __ct.hold(null); __ct.photo(null); }); await scene(false);
} else console.log('  no lawman came close', JSON.stringify(law), JSON.stringify(st));
st = await state();
for (let i = 0; i < 40 && !st.jailed && !st.dead; i++) { await wait(1000); st = await state(); }
await page.keyboard.up('KeyX');
if (st.dead) { for (let i = 0; i < 10 && !st.jailed; i++) { await wait(1000); st = await state(); } }
console.log('  taken in', JSON.stringify(st)); const jailed = st.jailed;
await page.evaluate(() => { const J = __ct.session.field.jail; __ct.photo([J.x + 4.2, J.y + 2.3, J.z + 5.2, J.x, J.y + 1.1, J.z]); });
await scene(true); await wait(3000); await shot('jail');
await page.evaluate(() => __ct.photo(null)); await scene(false);

// ---- out again at the office door, the horse beside it: up, west out of town at a gallop, and a jump, from the side
for (let i = 0; i < 70 && st.jailed; i++) { await wait(1000); st = await state(); }
console.log('  let out', JSON.stringify(st));
await wait(800); await press('KeyE'); await wait(600);
await page.evaluate(() => { __ct.controls.intent.yaw = Math.PI / 2; __ct.controls.intent.pitch = -0.05; });
await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await wait(6500);
await scene(true);
await page.evaluate(() => __ct.photo(s => { const h = s.horse, sx = Math.cos(h.yaw), sz = -Math.sin(h.yaw); return [h.x - sx * 6 + Math.sin(h.yaw) * 1.2, h.y + 1.8, h.z - sz * 6 + Math.cos(h.yaw) * 1.2, h.x - Math.sin(h.yaw) * 0.8, h.y + 1.5, h.z - Math.cos(h.yaw) * 0.8]; }));
await wait(2500);
await page.evaluate(() => __ct.hold(s => s.a.h && !s.a.h.ground && s.a.h.vy < 2.5 && s.a.h.vy > -2));
await press('Space', 80);
if (await page.waitForFunction(() => __ct.holding, null, { timeout: 15000 }).then(() => true).catch(() => false)) await shot('jump'); else console.log('  missed jump');
await page.evaluate(() => { __ct.hold(null); __ct.photo(null); }); await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
console.log('  jumped at', JSON.stringify(await page.evaluate(() => [Math.round(__ct.session.x), Math.round(__ct.session.z), __ct.session.a.riding])));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(errors.length || !jailed ? 1 : 0);
