// Footfalls, made on the spot from filtered noise as HoodWar makes its sounds: no audio files. Hearing each foot
// land is a large part of feeling a body's weight, and hearing someone else's tells you a runner is coming up
// behind. Starts on the first click, since browsers do not let a page make sound before one.
export function createSteps() {
  let ctx = null, noise = null, out = null, on = true, budget = 0;
  function start() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext; if (!AC) return;
    try {
      ctx = new AC(); out = ctx.createGain(); out.gain.value = 0.55; out.connect(ctx.destination);
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
      const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { ctx = null; }
  }
  // one soft thud: loudness 0..1, how dull it is (Hz), how long it rings (s)
  function thud(gain, cutoff, len) {
    if (!ctx || !on || ctx.state !== 'running' || budget <= 0 || gain < 0.004) return;
    budget--;
    const t = ctx.currentTime, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise; f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.7;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    src.connect(f); f.connect(g); g.connect(out); src.start(t, Math.random() * 0.25, len + 0.03);
  }
  return {
    start,
    frame() { budget = 6; },                                     // at most this many new sounds a frame
    // a foot coming down at `speed` m/s, `dist` metres from the listener
    step(speed, dist) { const near = 1 / (1 + dist * dist / 40); thud((0.07 + Math.min(0.2, speed * 0.03)) * near, 420 + speed * 110 + Math.random() * 160, 0.07 + Math.random() * 0.03); },
    land(dist) { thud(0.42 / (1 + dist * dist / 40), 300, 0.17); },
    set enabled(v) { on = !!v; }, get enabled() { return on; },
  };
}
