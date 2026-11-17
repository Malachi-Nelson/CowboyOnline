// The in-tab world's own thread. The page starts this as a Web Worker so the world keeps its 20 ticks a second
// whatever the drawing is doing; a slow frame on screen must not slow the world down. Bytes go across as they
// would over a socket.
import { World } from '../../../server/src/core/world.js';

let world = null, client = null, timer = null;
const status = () => { const s = world.status(); postMessage({ t: 'status', entities: s.entities, tickMs: s.tickMs.p99, bots: s.bots }); };
onmessage = e => {
  const m = e.data;
  if (m instanceof ArrayBuffer) { if (world && client) world.receive(client, new Uint8Array(m)); return; }
  if (m.t === 'start') {
    world = new World(m.opts);
    client = world.connect({ send: b => postMessage(b.buffer, [b.buffer]), close: () => postMessage({ t: 'closed' }), buffered: 0 });
    world.start(); timer = setInterval(status, 1000);
    postMessage({ t: 'open' }); status();
  } else if (m.t === 'stop') { clearInterval(timer); if (world) { world.stop(); world.disconnect(client); } close(); }
};
