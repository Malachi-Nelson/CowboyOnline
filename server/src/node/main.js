// The Node gateway: one HTTP server that answers health and status checks and upgrades everything else to a
// WebSocket, handing each connection to the world. All the game logic is in ../core; this file is the only place
// that knows about sockets.
//
//   PORT     port to listen on (default 8080; hosts such as Render set this for you)
//   BOTS     bots to keep in the world (default 63; they make room as people join)
//   SPAWN    hub | spread (spread scatters everyone over the whole map; used by the load test)
//   ORIGINS  comma-separated list of page origins allowed to connect (default: any)
//   ALLOW_RESET=1 lets /reset-metrics clear the timings (the load test uses it; leave it off when hosting)
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { World } from '../core/world.js';
import { MAX_PLAYERS } from '../../../shared/constants.js';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const PORT = num(process.env.PORT, 8080);
const ORIGINS = (process.env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const world = new World({ bots: num(process.env.BOTS, 63), spawn: process.env.SPAWN === 'spread' ? 'spread' : 'hub', maxPlayers: num(process.env.MAX_PLAYERS, MAX_PLAYERS) });
const started = Date.now();

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  const head = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (path === '/health') { res.writeHead(200, { ...head, 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (path === '/status') {
    const cpu = process.cpuUsage(), mem = process.memoryUsage();
    res.writeHead(200, { ...head, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...world.status(), process: { node: process.version, upS: Math.round((Date.now() - started) / 1000), rssMB: Math.round(mem.rss / 1048576 * 10) / 10, heapMB: Math.round(mem.heapUsed / 1048576 * 10) / 10, heapTotalMB: Math.round(mem.heapTotal / 1048576 * 10) / 10, externalMB: Math.round(mem.external / 1048576 * 10) / 10, arrayBuffersMB: Math.round(mem.arrayBuffers / 1048576 * 10) / 10, cpuMs: Math.round((cpu.user + cpu.system) / 1000) } }));
    return;
  }
  if (path === '/reset-metrics' && process.env.ALLOW_RESET === '1') { world.resetMetrics(); res.writeHead(200, head); res.end('ok'); return; }
  if (path === '/gc' && process.env.ALLOW_RESET === '1') { const had = typeof globalThis.gc === 'function'; if (had) globalThis.gc(); res.writeHead(200, head); res.end(had ? 'collected' : 'start node with --expose-gc'); return; }
  res.writeHead(200, { ...head, 'content-type': 'text/plain' });
  res.end('Calder Territory game server. Connect with the game client; see /status.\n');
});

const wss = new WebSocketServer({
  server, maxPayload: 512, perMessageDeflate: false,
  verifyClient: ORIGINS.length ? info => ORIGINS.includes(info.origin) : undefined,
});
wss.on('connection', ws => {
  if (wss.clients.size > world.opts.maxPlayers + 16) { ws.close(1013, 'busy'); return; }
  const c = world.connect({
    send: bytes => { if (ws.readyState === 1) ws.send(bytes, { binary: true }); },
    close: () => ws.close(),
    get buffered() { return ws.bufferedAmount; },
  });
  const hello = setTimeout(() => { if (!c.player) world.kick(c); }, 5000);   // say who you are, or go
  ws.on('message', (data, isBinary) => { if (isBinary) world.receive(c, data); else world.kick(c); });
  ws.on('close', () => { clearTimeout(hello); world.disconnect(c); });
  ws.on('error', () => { /* 'close' follows */ });
});

server.listen(PORT, () => {
  world.start();
  console.log(`Calder Territory server on :${PORT}  bots=${world.bots.length}  spawn=${world.opts.spawn}  node=${process.version}`);
});

const stop = () => { world.stop(); for (const ws of wss.clients) ws.close(1001, 'server stopping'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
