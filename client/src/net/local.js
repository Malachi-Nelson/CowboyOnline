// A whole world inside this browser tab. This is the one place the client is allowed to import server code: the
// server's core has no Node in it, so the same authoritative world that runs on a host can run here, with bots, for
// free solo play and for testing. The session talks to it through the same messages it would send over a socket.
import { World } from '../../../server/src/core/world.js';

export class LocalTransport {
  constructor(opts) { this.world = new World(opts); this.c = null; this.onopen = this.onmessage = this.onclose = null; }
  open() {
    this.c = this.world.connect({
      send: bytes => { if (this.onmessage) this.onmessage(bytes); },
      close: () => { if (this.onclose) this.onclose('The world closed the connection.'); },
      buffered: 0,
    });
    this.world.start();
    queueMicrotask(() => { if (this.onopen) this.onopen(); });
  }
  send(bytes) { if (this.c) this.world.receive(this.c, bytes); }
  close() { this.world.stop(); if (this.c) this.world.disconnect(this.c); this.c = null; }
}
