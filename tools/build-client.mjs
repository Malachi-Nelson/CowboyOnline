// Builds the game page: every client module bundled into one script and set into one HTML file with its styles.
//
//   node tools/build-client.mjs            client/dist/index.html     a complete page, for GitHub Pages or opening locally
//                                          client/dist/artifact.html  the same page as a fragment, for publishing as a preview
//   --inline-three                         put three.js in the file too, so it works with no network at all
//   --serve [port]                         build, then serve client/dist and rebuild on every page load
//
// three.js r128 comes from the same CDN address HoodWar uses, ahead of the bundle.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const FONTS = 'https://fonts.googleapis.com/css2?family=Besley:wght@500;800&family=Libre+Franklin:wght@400;500;600&display=swap';
const TITLE = 'Cowboy Online';
const ABOUT = 'Cowboy Online: a frontier open world for the browser, set in Calder Territory in 1899. This is the Phase 2 networking test range.';
// a brass star on lamp-black, drawn inline so the page asks the network for nothing but three.js and its fonts
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='10' fill='%2314110d'/%3E%3Cpath fill='%23dba64c' d='M32 9l6.2 15.4 16.6 1.2-12.8 10.7 4 16.2L32 43.6 18 52.5l4-16.2L9.2 25.6l16.6-1.2z'/%3E%3C/svg%3E";

export async function make() {
  const opts = { bundle: true, format: 'iife', minify: true, write: false, target: ['es2020'], legalComments: 'none', logLevel: 'warning' };
  // the in-tab world is bundled on its own and carried inside the page as text, to be started as a worker
  const worker = await build({ ...opts, entryPoints: [resolve(ROOT, 'client/src/net/world-worker.js')] });
  const out = await build({ ...opts, entryPoints: [resolve(ROOT, 'client/src/main.js')], define: { __WORLD_WORKER__: JSON.stringify(worker.outputFiles[0].text) } });
  const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = readFileSync(resolve(ROOT, 'client/src/ui/style.css'), 'utf8'), body = readFileSync(resolve(ROOT, 'client/src/ui/page.html'), 'utf8');
  const three = args.includes('--inline-three')
    ? `<script>${readFileSync(resolve(ROOT, 'node_modules/three/build/three.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`
    : `<script src="${THREE_URL}"></script>`;
  const head = `<title>${TITLE}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<link rel="stylesheet" href="${FONTS}">\n<style>\n${css}</style>`;
  const scripts = `${three}\n<script>\n${js}</script>`;
  // the preview host wraps a fragment in its own document and pads the root for a phone's system bars; the
  // standalone page does the same for itself
  const artifact = `${head}\n${body.replace('<div id="app">', '<div id="app" data-host="artifact">')}\n${scripts}\n`;
  const page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="description" content="${ABOUT}">\n<meta name="theme-color" content="#14110d">\n<meta property="og:title" content="${TITLE}">\n<meta property="og:description" content="${ABOUT}">\n<meta property="og:type" content="website">\n<link rel="icon" href="${ICON}">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<style>:root{padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}</style>\n${head}\n</head>\n<body>\n${body}\n${scripts}\n</body>\n</html>\n`;
  mkdirSync(resolve(ROOT, 'client/dist'), { recursive: true });
  writeFileSync(resolve(ROOT, 'client/dist/index.html'), page); writeFileSync(resolve(ROOT, 'client/dist/artifact.html'), artifact);
  return { bundle: js.length, page: page.length };
}

const r = await make();
console.log(`built client/dist/index.html (${(r.page / 1024).toFixed(0)} KB; script ${(r.bundle / 1024).toFixed(0)} KB)`);
if (args.includes('--serve')) {
  const port = +(args[args.indexOf('--serve') + 1]) || 5173;
  createServer(async (req, res) => {
    try { await make(); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(readFileSync(resolve(ROOT, 'client/dist/index.html'))); }
    catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e && e.message)); }
  }).listen(port, () => console.log(`serving http://localhost:${port}  (rebuilds on every load)`));
}
