// Every sound in the game, made on the spot from noise and oscillators as HoodWar makes its sounds: no audio files.
// Footfalls and hoofbeats are half of feeling weight and speed; the whistle has to carry; and the wind, the river,
// birds by day and crickets at night are most of what makes a place feel like a place. Starts on the first click,
// since browsers do not let a page make sound before one.
export function createSound() {
  let ctx = null, noise = null, out = null, amb = null, on = true, budget = 0;
  const loops = {};
  function start() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext; if (!AC) return;
    try {
      ctx = new AC(); out = ctx.createGain(); out.gain.value = 0.6; out.connect(ctx.destination);
      amb = ctx.createGain(); amb.gain.value = 0.5; amb.connect(out);
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
      const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // looping beds: wind, running water, rain. Their loudness is set every frame from where the listener is.
      const bed = (type, f, q) => { const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noise; s.loop = true; fl.type = type; fl.frequency.value = f; fl.Q.value = q; g.gain.value = 0; s.connect(fl); fl.connect(g); g.connect(amb); s.start(0, Math.random() * 1.5); return { g, fl }; };
      loops.wind = bed('lowpass', 380, 0.6); loops.water = bed('bandpass', 900, 0.4); loops.rain = bed('highpass', 2200, 0.3);
    } catch (e) { ctx = null; }
  }
  const ready = () => ctx && on && ctx.state === 'running';
  // one burst of filtered noise: loudness 0..1, filter, how long it rings (s)
  function burst(gain, type, freq, q, len, at = 0) {
    if (!ready() || budget <= 0 || gain < 0.004) return;
    budget--;
    const t = ctx.currentTime + at, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    src.connect(f); f.connect(g); g.connect(out); src.start(t, Math.random() * 1.5, len + 0.05);
  }
  const near = d => 1 / (1 + d * d / 40);
  // a tone that slides: whistles and birdsong
  function tone(gain, f0, f1, len, at = 0, vib = 0, dest = out) {
    if (!ready() || gain < 0.003) return;
    const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + len * 0.6); o.frequency.exponentialRampToValueAtTime(f0 * 1.02, t + len);
    if (vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 6.5; lg.gain.value = vib; l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + len + 0.05); }
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.03); g.gain.setValueAtTime(gain, t + len * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + len + 0.05);
  }
  let birdAt = 0, cricketAt = 0;
  return {
    start,
    frame() { budget = 14; },                                    // at most this many new sounds a frame
    // a foot coming down at `speed` m/s, `dist` metres from the listener
    step(speed, dist) { burst((0.07 + Math.min(0.2, speed * 0.03)) * near(dist), 'lowpass', 420 + speed * 110 + Math.random() * 160, 0.7, 0.07 + Math.random() * 0.03); },
    land(dist) { burst(0.42 * near(dist), 'lowpass', 300, 0.7, 0.17); },
    // a hoof: gait 0..3 (walk to gallop); surface 0 earth, 1 boards, 2 water, 3 snow
    hoof(gait, dist, surface) {
      const k = (0.16 + gait * 0.07) / (1 + dist * dist / 160);
      if (surface === 1) { burst(k * 1.1, 'bandpass', 1300 + Math.random() * 300, 3, 0.09); burst(k * 0.5, 'lowpass', 260, 1, 0.12); }
      else if (surface === 2) burst(k * 0.9, 'bandpass', 1600 + Math.random() * 900, 0.8, 0.22);
      else if (surface === 3) burst(k * 0.6, 'lowpass', 520 + Math.random() * 120, 0.5, 0.14);
      else { burst(k, 'lowpass', 190 + gait * 30 + Math.random() * 60, 1.2, 0.13); burst(k * 0.35, 'bandpass', 900 + Math.random() * 300, 1.5, 0.05); }
    },
    // a horse coming down from a jump: all four hooves at once, heavier the further it fell
    thud(dist, surface, hard = 0.7) {
      const k = (0.34 + hard * 0.3) / (1 + dist * dist / 200);
      if (surface === 2) { burst(k * 1.2, 'bandpass', 1100 + Math.random() * 600, 0.7, 0.4); return; }
      burst(k, 'lowpass', 120 + Math.random() * 30, 1, 0.24); burst(k * 0.7, 'lowpass', 220, 1.2, 0.14, 0.045);
      if (surface === 1) burst(k * 0.8, 'bandpass', 1150, 2.5, 0.12);
      else if (surface === 3) burst(k * 0.5, 'lowpass', 600, 0.5, 0.2);
      else burst(k * 0.3, 'bandpass', 800 + Math.random() * 300, 1.2, 0.09, 0.02);
    },
    // A gunshot: the crack, the boom behind it, and the roll of it coming back off the hills or the buildings.
    // Further off it is quieter, duller, and its echo is a bigger share of it. gun 1 revolver, 2 repeater
    shot(gun, dist, town) {
      if (!ready()) return;
      const near = 1 / (1 + dist * dist / 900), far = Math.min(1, dist / 250), big = gun === 2 ? 1.25 : 1;
      burst(0.9 * near * big, 'bandpass', 2600 - far * 1700 + Math.random() * 300, 0.9, 0.05);
      burst(0.8 * near * big + 0.05, 'lowpass', 520 - far * 260, 0.8, 0.22);
      burst(0.5 * near * big, 'lowpass', 140, 1.1, 0.3);
      const tail = (0.12 + 0.2 * far) * (0.6 + near) * (town ? 1.3 : 1);
      burst(tail, 'lowpass', 380 - far * 150, 0.5, 1.3, 0.12 + Math.min(0.5, dist / 400));
      if (town) burst(tail * 0.6, 'bandpass', 900, 0.6, 0.5, 0.06);
    },
    // the hammer falling on nothing; a round going in; the lever or hammer worked
    click(dist = 0) { burst(0.25 / (1 + dist * dist / 30), 'bandpass', 3400, 4, 0.03); },
    load(dist = 0) { const k = 1 / (1 + dist * dist / 30); burst(0.14 * k, 'bandpass', 2400 + Math.random() * 600, 3, 0.04); burst(0.08 * k, 'bandpass', 1500, 2, 0.05, 0.05); },
    cock(gun, dist = 0) { const k = 1 / (1 + dist * dist / 30); if (gun === 2) { burst(0.2 * k, 'bandpass', 1700, 3, 0.05); burst(0.24 * k, 'bandpass', 2300, 3, 0.05, 0.12); } else burst(0.16 * k, 'bandpass', 2900, 5, 0.035); },
    // where a shot landed: dirt, wood, water, a tree, or someone
    impact(struck, dist) {
      const k = 1 / (1 + dist * dist / 120); if (k < 0.01) return;
      if (struck === 2) { burst(0.4 * k, 'bandpass', 900, 1.4, 0.09); burst(0.2 * k, 'bandpass', 2200, 2, 0.05); }
      else if (struck === 4) burst(0.35 * k, 'bandpass', 1500, 0.7, 0.25);
      else if (struck === 3) burst(0.35 * k, 'bandpass', 700, 1.2, 0.1);
      else if (struck === 5 || struck === 6) burst(0.45 * k, 'lowpass', 260, 1, 0.12);
      else { burst(0.3 * k, 'lowpass', 600, 0.8, 0.12); if (Math.random() < 0.18) tone(0.04 * k, 2600 + Math.random() * 1500, 900, 0.35); }   // now and then a ricochet
    },
    // a bullet going past close by
    whiz(miss) { const k = Math.max(0, 1 - miss / 4); if (k < 0.05) return; burst(0.35 * k, 'bandpass', 3200 + Math.random() * 1600, 2.5, 0.12); },
    // being hit
    hurt(heavy) { burst(heavy ? 0.7 : 0.45, 'lowpass', 160, 1, 0.25); tone(0.05, 3800, 3600, 0.5, 0.02); },
    // Iron Nerve: a slow heartbeat under everything else, and the world's sounds pushed back
    focus(on) {
      if (!ready()) return;
      const t = ctx.currentTime;
      amb.gain.setTargetAtTime(on ? 0.12 : 0.5, t, 0.15); out.gain.setTargetAtTime(on ? 0.45 : 0.6, t, 0.15);
    },
    heartbeat() { burst(0.5, 'lowpass', 70, 1.2, 0.16); burst(0.35, 'lowpass', 60, 1.2, 0.14, 0.2); },
    // two rising notes and a fall: a whistle for a horse. Others' whistles come from further off.
    whistle(dist = 0) {
      const g = 0.16 / (1 + dist * dist / 900);
      tone(g, 1700, 2500, 0.32, 0, 18); tone(g, 1900, 2900, 0.42, 0.36, 22);
    },
    // a horse blowing out through its nose
    snort(dist = 0) { burst(0.3 / (1 + dist * dist / 60), 'bandpass', 520, 1.4, 0.32); burst(0.12 / (1 + dist * dist / 60), 'bandpass', 1400, 2, 0.2, 0.05); },
    // the beds, every frame: wind rises with height and speed, water with nearness to it, rain with the rain
    ambience(o, dt) {
      if (!ready()) return;
      const s = (g, v) => g.gain.setTargetAtTime(v, ctx.currentTime, 0.4);
      s(loops.wind.g, 0.05 + Math.min(0.5, o.height / 600) + Math.min(0.25, o.speed * 0.018) + o.storm * 0.25);
      loops.wind.fl.frequency.setTargetAtTime(300 + o.speed * 40 + o.storm * 300, ctx.currentTime, 0.5);
      s(loops.water.g, Math.max(0, 0.35 - o.water / 120) * (o.rapids ? 1.6 : 1));
      s(loops.rain.g, o.rain * 0.35);
      // birds in the day, crickets in the evening, only when it is dry and not too high up
      const t = ctx.currentTime;
      if (o.day > 0.6 && o.rain < 0.2 && o.height < 160 && t > birdAt) { birdAt = t + 2 + Math.random() * 7; const f = 2400 + Math.random() * 2200, n = 2 + (Math.random() * 4 | 0); for (let i = 0; i < n; i++) tone(0.025, f, f * (1.1 + Math.random() * 0.4), 0.09 + Math.random() * 0.08, i * 0.13, 0, amb); }
      if (o.day < 0.35 && o.rain < 0.2 && o.height < 160 && t > cricketAt) { cricketAt = t + 0.6 + Math.random() * 1.4; const f = 4200 + Math.random() * 600; for (let i = 0; i < 3; i++) tone(0.012, f, f * 1.01, 0.05, i * 0.09, 0, amb); }
      void dt;
    },
    set enabled(v) { on = !!v; if (amb) amb.gain.value = on ? 0.5 : 0; }, get enabled() { return on; },
  };
}
