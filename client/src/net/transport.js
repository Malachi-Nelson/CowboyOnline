// Ways to reach a world. Each has the same small shape: open(), send(bytes), close(), and the callbacks onopen,
// onmessage(bytes), onclose(reason). The session does not know which one it has.

// A WebSocket to a hosted server. Works in the browser and in Node 22, which both have a global WebSocket.
export class WsTransport {
  constructor(url, WS = globalThis.WebSocket) { this.url = url; this.WS = WS; this.ws = null; this.onopen = this.onmessage = this.onclose = null; }
  open() {
    const ws = this.ws = new this.WS(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { if (this.onopen) this.onopen(); };
    ws.onmessage = ev => { if (this.onmessage && ev.data instanceof ArrayBuffer) this.onmessage(new Uint8Array(ev.data)); };
    ws.onclose = ev => { if (this.onclose) this.onclose(ev.reason || (ev.code === 1006 ? 'The connection was lost.' : '')); };
    ws.onerror = () => { /* onclose follows */ };
  }
  send(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }
  close() { if (this.ws) this.ws.close(); }
}

// Wraps another transport and holds every message back, each way, by `lag` ms plus up to `jitter` ms more, keeping
// them in order as a real connection would. With both at zero it passes straight through. The game page uses it to
// let you feel 150 ms of ping on a local world; the load test uses it for the same reason.
export class LagTransport {
  constructor(inner, lag = 0, jitter = 0, rand = Math.random) {
    this.inner = inner; this.lag = lag; this.jitter = jitter; this.rand = rand;
    this.onopen = this.onmessage = this.onclose = null;
    this.up = { q: [], last: 0, timer: null, run: b => this.inner.send(b) };
    this.down = { q: [], last: 0, timer: null, run: b => { if (this.onmessage) this.onmessage(b); } };
    inner.onopen = () => { if (this.onopen) this.onopen(); };
    inner.onclose = r => { this.closed = true; if (this.onclose) this.onclose(r); };
    inner.onmessage = b => this.hold(this.down, b);
  }
  open() { this.inner.open(); }
  send(bytes) { this.hold(this.up, bytes); }
  close() { this.closed = true; for (const d of [this.up, this.down]) { clearTimeout(d.timer); d.q.length = 0; } this.inner.close(); }
  hold(d, bytes) {
    if (this.lag <= 0 && this.jitter <= 0 && !d.q.length) { d.run(bytes); return; }
    const now = performance.now(); let at = now + this.lag + this.rand() * this.jitter;
    if (at < d.last) at = d.last;                               // never overtake the message before
    d.last = at; d.q.push(at, bytes);
    if (!d.timer) d.timer = setTimeout(() => this.pump(d), at - now);
  }
  pump(d) {
    d.timer = null;
    const now = performance.now() + 0.5, q = d.q; let i = 0;
    while (i < q.length && q[i] <= now) { if (!this.closed) d.run(q[i + 1]); i += 2; }
    if (i) q.splice(0, i);
    if (q.length && !this.closed) d.timer = setTimeout(() => this.pump(d), Math.max(0, q[0] - performance.now()));
  }
}
