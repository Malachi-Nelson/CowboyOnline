// Rain and snow, drawn in a box that travels with the camera. Every drop's place is worked out on the graphics card
// from the time, so nothing is updated per drop; the only thing that changes frame to frame is how many of them show.
import { THREE } from './three.js';

const RAIN = 2400, SNOW = 2200, BOX = 46, HIGH = 26;
const VERT = `
uniform float uTime, uAmount, uSpeed, uLen, uSnow; uniform vec3 uCam; uniform vec2 uWind;
attribute vec4 seed; varying float vA;
#include <fog_pars_vertex>
void main() {
  float on = step(seed.w, uAmount);
  float fall = mod(seed.y * ${HIGH.toFixed(1)} - uTime * uSpeed * (0.85 + seed.z * 0.3), ${HIGH.toFixed(1)});
  vec3 p = vec3(seed.x, 0.0, seed.z) * ${BOX.toFixed(1)};
  p.xz += uWind * (${HIGH.toFixed(1)} - fall) * 0.12 + vec2(sin(uTime * 0.9 + seed.x * 40.0), cos(uTime * 0.7 + seed.z * 40.0)) * uSnow * 0.6;
  p.xz = mod(p.xz - uCam.xz + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)};
  vec3 w = vec3(uCam.x + p.x, uCam.y - 8.0 + fall, uCam.z + p.z);
  w.xz += position.y * uWind * 0.02; w.y += position.y * uLen;
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mvPosition; if (on < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = uSnow * clamp(42.0 / -mvPosition.z, 1.0, 6.0);
  vA = on;
  #include <fog_vertex>
}`;
const FRAG = `uniform vec3 uColor; uniform float uAlpha, uSnow; varying float vA;
#include <fog_pars_fragment>
void main() {
  float a = uAlpha;
  if (uSnow > 0.5) { vec2 c = gl_PointCoord - 0.5; a *= smoothstep(0.5, 0.2, length(c)); }
  gl_FragColor = vec4(uColor, a * vA);
  #include <fog_fragment>
}`;

export function createWeather(scene) {
  const make = (n, lines, snow) => {
    const seeds = new Float32Array(n * (lines ? 2 : 1) * 4), pos = new Float32Array(n * (lines ? 2 : 1) * 3);
    let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const a = [r(), r(), r(), (i + 0.5) / n];
      for (let k = 0; k < (lines ? 2 : 1); k++) { const v = i * (lines ? 2 : 1) + k; seeds.set(a, v * 4); pos[v * 3 + 1] = k; }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    const uni = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uAmount: { value: 0 }, uSpeed: { value: snow ? 1.3 : 11 }, uLen: { value: snow ? 0 : 0.55 }, uSnow: { value: snow ? 1 : 0 }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector2(1.6, 0.8) }, uColor: { value: new THREE.Color(snow ? 0xf2f4f8 : 0xaeb8c2) }, uAlpha: { value: snow ? 0.9 : 0.42 } }]);
    const m = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: true });
    const o = lines ? new THREE.LineSegments(g, m) : new THREE.Points(g, m);
    o.frustumCulled = false; o.renderOrder = 3; o.visible = false; scene.add(o);
    return o;
  };
  const rain = make(RAIN, true, false), snow = make(SNOW, false, true);
  return {
    update(w, cam, time, env) {
      for (const [o, amt] of [[rain, w.rain], [snow, w.snow]]) {
        o.visible = amt > 0.02; if (!o.visible) continue;
        const u = o.material.uniforms; u.uTime.value = time; u.uAmount.value = amt; u.uCam.value.copy(cam.position);
        u.uColor.value.setRGB(0.55, 0.6, 0.66).multiplyScalar(o === snow ? 1.5 * (0.35 + 0.65 * env.day) : 0.4 + 0.6 * env.day);
      }
    },
    dispose() { for (const o of [rain, snow]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); } },
  };
}
