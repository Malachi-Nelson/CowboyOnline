// The renderer, the sky and the light. Same pipeline as HoodWar (sRGB output, ACES tone mapping, a hemisphere light
// and a sun) so its materials can be carried over later without re-tuning. The look here is a low evening sun over
// open country: long warm light, haze on the horizon.
import { THREE } from './three.js';

export const SUN_DIR = new THREE.Vector3(-0.62, 0.36, -0.7).normalize();
const HAZE = 0xcdbb9c;
const lin = h => new THREE.Color(h).convertSRGBToLinear();

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const coarse = matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2));

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(lin(HAZE), 110, 560);
  scene.add(new THREE.HemisphereLight(lin(0xc4d4e8), lin(0x7a6848), 0.85));
  const sun = new THREE.DirectionalLight(lin(0xffd9a6), 1.5); sun.position.copy(SUN_DIR); scene.add(sun);

  // sky: a dome that follows the camera, shaded from haze at the horizon to deep blue overhead, warmer toward the sun
  const geo = new THREE.SphereGeometry(2000, 40, 20), pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  const zen = lin(0x2c5a8c), mid = lin(0x7fa6c4), hor = lin(HAZE), glow = lin(0xffd9a0), c = new THREE.Color(), v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const h = Math.max(0, v.y), t = Math.pow(h, 0.55);
    if (t < 0.35) c.copy(hor).lerp(mid, t / 0.35); else c.copy(mid).lerp(zen, (t - 0.35) / 0.65);
    const s = Math.max(0, v.dot(SUN_DIR)); c.lerp(glow, Math.pow(s, 6) * 0.75 * (1 - h * 0.6));
    if (v.y < 0) c.copy(hor);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);
  // the sun itself
  const disc = new THREE.Mesh(new THREE.CircleGeometry(46, 32), new THREE.MeshBasicMaterial({ color: 0xfff1cf, fog: false, depthWrite: false, toneMapped: false }));
  disc.renderOrder = -9; scene.add(disc);

  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    return [w, h];
  }
  function render(cam) {
    sky.position.copy(cam.position);
    disc.position.copy(cam.position).addScaledVector(SUN_DIR, 1900); disc.lookAt(cam.position);
    renderer.render(scene, cam);
  }
  return { renderer, scene, resize, render };
}
