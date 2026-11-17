// How long each world tick took, kept for the last half hour so the load test can ask for percentiles.
import { percentile } from '../../../shared/math.js';

export class Metrics {
  constructor(n = 36000) { this.ticks = new Float32Array(n); this.n = 0; this.i = 0; }
  tick(ms) {
    this.ticks[this.i] = ms;
    this.i = (this.i + 1) % this.ticks.length;
    if (this.n < this.ticks.length) this.n++;
  }
  reset() { this.n = 0; this.i = 0; }
  summary() {
    const a = this.ticks.slice(0, this.n).sort();
    let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i];
    const r = v => Math.round(v * 1000) / 1000;
    return { n: a.length, avg: r(a.length ? sum / a.length : 0), p50: r(percentile(a, 0.5)), p95: r(percentile(a, 0.95)), p99: r(percentile(a, 0.99)), max: r(a.length ? a[a.length - 1] : 0) };
  }
}
