// A whole world inside this browser tab. This is the one place the client is allowed to reach for server code: the
// server's core has no Node in it, so the same authoritative world that runs on a host can run here, with bots, for
// free solo play and for testing. The session talks to it with the same messages it would send over a socket.
//
// The world gets a thread of its own (a Web Worker built from the same bundle) so it ticks on time whatever the
// drawing is doing. Where a worker cannot be started it runs on the page's thread instead.
import { World } from '../../../server/src/core/world.js';

export class LocalTransport {
  constructor(opts) { this.opts = opts; this.worker = null; this.world = null; this.c = null; this.total = 0; this.threaded = false; this.onopen = this.onmessage = this.onclose = null; }
  open() {
    const src = typeof __WORLD_WORKER__ === 'string' ? __WORLD_WORKER__ : '';
    if (src && typeof Worker === 'function') {
      try {
        const w = this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = e => {
          const m = e.data;
          if (m instanceof ArrayBuffer) { if (this.onmessage) this.onmessage(new Uint8Array(m)); }
          else if (m.t === 'status') this.total = m.entities;
          else if (m.t === 'open') { this.threaded = true; if (this.onopen) this.onopen(); }
          else if (m.t === 'closed') { if (this.onclose) this.onclose('The world closed the connection.'); }
        };
        w.onerror = () => { if (!this.threaded) { this.worker = null; this.inPage(); } };   // could not start: fall back
        w.postMessage({ t: 'start', opts: this.opts });
        return;
      } catch (e) { this.worker = null; }
    }
    this.inPage();
  }
  inPage() {
    const world = this.world = new World(this.opts);
    this.c = world.connect({
      send: bytes => { this.total = world.list.length; if (this.onmessage) this.onmessage(bytes); },
      close: () => { if (this.onclose) this.onclose('The world closed the connection.'); },
      buffered: 0,
    });
    world.start();
    queueMicrotask(() => { if (this.onopen) this.onopen(); });
  }
  send(bytes) {
    if (this.worker) { const b = bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer; this.worker.postMessage(b, [b]); }
    else if (this.c) this.world.receive(this.c, bytes);
  }
  close() {
    if (this.worker) { this.worker.postMessage({ t: 'stop' }); this.worker = null; }
    else if (this.world) { this.world.stop(); if (this.c) this.world.disconnect(this.c); this.c = null; }
  }
}
