// The renderer, the sky and the light. Same pipeline as HoodWar (sRGB output, ACES tone mapping, a hemisphere light
// and a sun) so its materials can be carried over later without re-tuning.
//
// The light follows the world's clock. The sun comes up in the east at six, crosses the southern sky and goes down
// in the west at six in the evening; the moon keeps the other half of the day. Everything that depends on the hour
// (sun colour, sky, haze, how dark the shade is) is read from one small table and blended between its rows.
import { THREE } from './three.js';

const lin = h => new THREE.Color(h).convertSRGBToLinear();
// hour, zenith, horizon, sun/moon light colour and strength, sky light, ground light, their strength, sun disc, stars
const DAY = [
  [0, 0x05070f, 0x0d1420, 0x8ea6d8, 0.42, 0x30426a, 0x0e1018, 0.55, 0x000000, 1],
  [4.6, 0x06080f, 0x101826, 0x8ea6d8, 0.4, 0x30426a, 0x0e1018, 0.55, 0x000000, 1],
  [5.6, 0x1c2a4a, 0x6a5560, 0xa08a90, 0.22, 0x4a5676, 0x2a2420, 0.6, 0xff8a50, 0.4],
  [6.3, 0x355a8c, 0xe8a070, 0xffa860, 0.9, 0x8ea0c0, 0x5a4a3c, 0.7, 0xffb070, 0],
  [8, 0x2c5f9c, 0xbfd0d8, 0xffe2b4, 1.45, 0xc4d4e8, 0x7a6848, 0.85, 0xfff1cf, 0],
  [12, 0x24569a, 0xb8d0e4, 0xfff4e0, 1.6, 0xcfdcee, 0x80705a, 0.9, 0xfffbea, 0],
  [16, 0x2a5a98, 0xc6cfd2, 0xffe6bc, 1.5, 0xc4d4e8, 0x7a6848, 0.85, 0xfff1cf, 0],
  [17.7, 0x34507e, 0xf0a868, 0xff9c50, 1.0, 0x9a98b0, 0x64503c, 0.7, 0xffa860, 0],
  [18.5, 0x2a3358, 0xc86a50, 0xd87858, 0.35, 0x5c5878, 0x3a2e2a, 0.6, 0xff7040, 0.3],
  [19.6, 0x0a0f20, 0x1c2238, 0x8ea6d8, 0.3, 0x2e3c60, 0x0e1016, 0.52, 0x000000, 0.9],
  [24, 0x05070f, 0x0d1420, 0x8ea6d8, 0.42, 0x30426a, 0x0e1018, 0.55, 0x000000, 1],
].map(r => [r[0], lin(r[1]), lin(r[2]), lin(r[3]), r[4], lin(r[5]), lin(r[6]), r[7], lin(r[8]), r[9]]);

const SKY_VERT = `varying vec3 vDir; void main() { vDir = position; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = `
uniform vec3 uZenith, uHorizon, uSunDir, uSunCol, uMoonDir; uniform float uStars, uHaze;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0), t = pow(h, 0.5);
  vec3 col = mix(uHorizon, uZenith, t);
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunCol * (pow(s, 8.0) * 0.35 + pow(s, 90.0) * 0.6) * (1.0 - h * 0.5);       // glow round the sun
  col = mix(col, uSunCol * 3.0, smoothstep(0.99955, 0.99975, s));                      // the sun itself
  float m = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.75, 0.82, 1.0) * (smoothstep(0.9996, 0.9998, m) * 0.9 + pow(m, 200.0) * 0.12) * uStars;
  if (uStars > 0.01 && d.y > 0.0) {                                                    // stars: a point in some cells of a fine grid on the dome
    vec3 p = d * 190.0, c = floor(p); float r = hash(c);
    float tw = smoothstep(0.34, 0.0, length(fract(p) - 0.5));
    col += vec3(0.9, 0.93, 1.0) * step(0.9965, r) * tw * uStars * smoothstep(0.02, 0.25, d.y) * (0.5 + 0.5 * fract(r * 91.7));
  }
  if (d.y < 0.0) col = uHorizon;
  col = mix(col, uHorizon, uHaze * (1.0 - smoothstep(0.0, 0.35, h)));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
}`;

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2));

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 150, 2300);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.85); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.5); scene.add(sun);

  const uni = { uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uStars: { value: 0 }, uHaze: { value: 0 } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.ShaderMaterial({ uniforms: uni, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false }));
  sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);

  // what the rest of the page may want to know about the light: where it comes from, how much of it is daylight,
  // and what colour distant things fade to
  const env = { sunDir: new THREE.Vector3(0.5, 0.6, 0.5), light: new THREE.Vector3(0.5, 0.6, 0.5), day: 1, night: 0, hour: 8, fog: new THREE.Color(), sunCol: new THREE.Color(), zenith: new THREE.Color(), horizon: new THREE.Color() };
  const c1 = new THREE.Color(), tmp = new THREE.Vector3();

  // hour: 0..24. mist: 0..1, thicker haze (the Mirewood, rain, snow). cloud: 0..1, an overcast sky
  const grey = new THREE.Color();
  function setTime(hour, mist = 0, cloud = 0) {
    let i = 0; while (i < DAY.length - 2 && hour >= DAY[i + 1][0]) i++;
    const a = DAY[i], b = DAY[i + 1], f = Math.min(1, Math.max(0, (hour - a[0]) / (b[0] - a[0]))), L = (k, out) => out.copy(a[k]).lerp(b[k], f), N = k => a[k] + (b[k] - a[k]) * f;
    const ang = (hour - 6) / 12 * Math.PI;
    env.sunDir.set(Math.cos(ang), Math.sin(ang) * 0.86, Math.sin(ang) * 0.5).normalize();
    tmp.set(-Math.cos(ang), -Math.sin(ang) * 0.8, 0.45 - Math.sin(ang) * 0.3).normalize();   // the moon, roughly opposite
    const up = env.sunDir.y; env.day = Math.min(1, Math.max(0, (up + 0.08) / 0.3)); env.night = N(9); env.hour = hour;
    env.light.copy(up > -0.05 ? env.sunDir : tmp); if (env.light.y < 0.12) { env.light.y = 0.12; env.light.normalize(); }
    L(1, uni.uZenith.value); L(2, uni.uHorizon.value); L(8, uni.uSunCol.value); uni.uSunDir.value.copy(env.sunDir); uni.uMoonDir.value.copy(tmp); uni.uStars.value = env.night; uni.uHaze.value = mist * 0.6;
    L(3, sun.color); sun.intensity = N(4); sun.position.copy(env.light);
    L(5, hemi.color); L(6, hemi.groundColor); hemi.intensity = N(7);
    if (cloud > 0.01) {                                         // overcast: a grey lid, no sun to speak of, light from everywhere
      const h = uni.uHorizon.value, lum = h.r * 0.3 + h.g * 0.55 + h.b * 0.15;
      grey.setRGB(lum * 0.92, lum * 0.95, lum); uni.uHorizon.value.lerp(grey, cloud * 0.7);
      grey.multiplyScalar(0.85); uni.uZenith.value.lerp(grey, cloud * 0.8);
      sun.intensity *= 1 - cloud * 0.72; hemi.intensity *= 1 + cloud * 0.2; uni.uSunCol.value.multiplyScalar(1 - cloud * 0.92); uni.uStars.value *= 1 - cloud;
    }
    env.fog.copy(uni.uHorizon.value); if (mist > 0) env.fog.lerp(c1.copy(uni.uHorizon.value).lerp(uni.uZenith.value, 0.25), mist * 0.5);
    scene.fog.color.copy(env.fog); scene.fog.near = 150 - mist * 110; scene.fog.far = 2300 - mist * 1500;
    env.sunCol.copy(sun.color).multiplyScalar(sun.intensity); env.zenith.copy(uni.uZenith.value); env.horizon.copy(uni.uHorizon.value);
  }
  setTime(8);

  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    if (w > 0 && h > 0) renderer.setSize(w, h, false);
    return [w, h];
  }
  function render(cam) {
    sky.position.copy(cam.position); sky.scale.setScalar(cam.far * 0.9);
    renderer.render(scene, cam);
  }
  return { renderer, scene, resize, render, setTime, env };
}
