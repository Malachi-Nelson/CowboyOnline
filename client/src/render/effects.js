// What a gunfight looks like besides the people in it: the flash and the cloud of black-powder smoke at the
// muzzle, a faint streak along the shot, and a puff where it lands (dust, splinters, a splash, bark, blood), with a
// hole left in a wall. All of it is drawn on this screen only; none of it is sent anywhere. One particle system, one
// set of lines and one set of holes, so a whole street firing is three draw calls.
import { THREE } from './three.js';
import { STRUCK } from '../../../shared/net/messages.js';

const N = 900, LINES = 48, HOLES = 96;
// kinds of particle: colour, how it moves, how long it lasts
const K = {
  flash: { add: true, col: [1.0, 0.86, 0.5], life: 0.07, size: 0.8, grow: 0.5, drag: 0, grav: 0, lift: 0 },
  spark: { add: true, col: [1.0, 0.7, 0.35], life: 0.18, size: 0.07, grow: 0, drag: 2, grav: 9, lift: 0 },
  smoke: { add: false, col: [0.8, 0.79, 0.76], life: 2.4, size: 0.5, grow: 1.8, drag: 1.6, grav: 0, lift: 0.45, alpha: 0.5 },
  dust: { add: false, col: [0.62, 0.52, 0.38], life: 1.0, size: 0.32, grow: 1.6, drag: 2.5, grav: 1.2, lift: 0, alpha: 0.75 },
  chip: { add: false, col: [0.55, 0.4, 0.24], life: 0.6, size: 0.06, grow: 0, drag: 0.6, grav: 12, lift: 0, alpha: 1 },
  splash: { add: false, col: [0.85, 0.9, 0.95], life: 0.55, size: 0.12, grow: 0.8, drag: 0.8, grav: 11, lift: 0, alpha: 0.8 },
  blood: { add: false, col: [0.5, 0.05, 0.03], life: 0.55, size: 0.16, grow: 0.9, drag: 1.2, grav: 9, lift: 0, alpha: 0.9 },
  snow: { add: false, col: [0.95, 0.96, 1.0], life: 0.8, size: 0.2, grow: 1.2, drag: 2.5, grav: 1, lift: 0, alpha: 0.8 },
};

const VERT = `attribute float aSize; attribute float aAlpha; attribute vec3 aCol; varying float vA; varying vec3 vC;
void main() { vA = aAlpha; vC = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * 620.0 / max(0.5, -mv.z); }`;
const FRAG = `uniform sampler2D uMap; uniform vec3 uFog; uniform float uFogNear, uFogFar; varying float vA; varying vec3 vC;
void main() { vec4 t = texture2D(uMap, gl_PointCoord); float a = t.a * vA; if (a < 0.01) discard;
  float d = 1.0 / gl_FragCoord.w; float f = smoothstep(uFogNear, uFogFar, d);
  gl_FragColor = vec4(mix(vC, uFog, f), a * (1.0 - f * 0.7));
  #include <tonemapping_fragment>
  #include <encodings_fragment>
}`;

export function createEffects(scene, field) {
  // a soft round dot, for every particle
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.65)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const dot = new THREE.CanvasTexture(cv);
  const fogU = { uFog: { value: new THREE.Color() }, uFogNear: { value: 150 }, uFogFar: { value: 2300 } };

  // two particle sets: smoke and dust blend normally, flashes and sparks add light
  function particles(additive) {
    const geo = new THREE.BufferGeometry(), pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({ uniforms: { uMap: { value: dot }, ...fogU }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.renderOrder = 3; scene.add(pts);
    return { geo, pos, col, size, alpha, pts, n: 0, list: [] };
  }
  const soft = particles(false), glow = particles(true);
  const P = [];                                                    // live particles: [set, kind, x, y, z, vx, vy, vz, age]

  function spawn(kind, x, y, z, vx, vy, vz) {
    const k = K[kind], set = k.add ? glow : soft;
    if (set.list.length >= N) set.list.shift();
    set.list.push({ k, x, y, z, vx, vy, vz, age: 0, life: k.life * (0.75 + Math.random() * 0.5), s: k.size * (0.8 + Math.random() * 0.4) });
  }
  const R = () => Math.random() * 2 - 1;

  // ---- streaks along shots
  const lgeo = new THREE.BufferGeometry(), lpos = new Float32Array(LINES * 6), lcol = new Float32Array(LINES * 6);
  lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3).setUsage(THREE.DynamicDrawUsage));
  lgeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = false; lines.renderOrder = 4; scene.add(lines);
  const streaks = [];

  // ---- holes in walls
  const hcv = document.createElement('canvas'); hcv.width = hcv.height = 32; const hg = hcv.getContext('2d'), hr = hg.createRadialGradient(16, 16, 1, 16, 16, 15);
  hr.addColorStop(0, 'rgba(10,8,6,1)'); hr.addColorStop(0.35, 'rgba(25,18,12,0.95)'); hr.addColorStop(0.6, 'rgba(70,52,34,0.5)'); hr.addColorStop(1, 'rgba(70,52,34,0)'); hg.fillStyle = hr; hg.fillRect(0, 0, 32, 32);
  const holes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.11, 0.11), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(hcv), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), HOLES);
  holes.count = 0; holes.frustumCulled = false; scene.add(holes);
  let holeN = 0; const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1), Z = new THREE.Vector3(0, 0, 1), Nrm = new THREE.Vector3();

  return {
    // a shot leaving a gun at (x, y, z) going (dx, dy, dz): the flash, a few sparks, and the smoke
    muzzle(x, y, z, dx, dy, dz, gun, near = true) {
      spawn('flash', x + dx * 0.08, y + dy * 0.08, z + dz * 0.08, dx * 2, dy * 2, dz * 2);
      if (near) for (let i = 0; i < 4; i++) spawn('spark', x, y, z, dx * 14 + R() * 3, dy * 14 + R() * 3 + 1, dz * 14 + R() * 3);
      const n = gun === 2 ? 7 : 5;
      for (let i = 0; i < n; i++) { const k = 0.6 + i * 0.35; spawn('smoke', x + dx * k * 0.5, y + dy * k * 0.5, z + dz * k * 0.5, dx * (3.2 - i * 0.4) + R() * 0.3, dy * (3.2 - i * 0.4) + R() * 0.3 + 0.2, dz * (3.2 - i * 0.4) + R() * 0.3); }
    },
    // a faint streak, brightest at the far end and gone in a tenth of a second
    tracer(x0, y0, z0, x1, y1, z1) { if (streaks.length >= LINES) streaks.shift(); streaks.push({ x0, y0, z0, x1, y1, z1, age: 0 }); },
    // a shot landing: what it struck decides what flies up. (nx, ny, nz): the way the surface faces
    impact(x, y, z, nx, ny, nz, struck, snowy = false) {
      if (struck === STRUCK.BODY || struck === STRUCK.HORSE) { for (let i = 0; i < 14; i++) spawn('blood', x, y, z, nx * 2 + R() * 1.4, ny * 2 + R() * 1.2 + 0.6, nz * 2 + R() * 1.4); return; }
      if (struck === STRUCK.WATER) { for (let i = 0; i < 10; i++) spawn('splash', x, y + 0.02, z, R() * 0.8, 2.5 + Math.random() * 2.5, R() * 0.8); return; }
      if (struck === STRUCK.WOOD || struck === STRUCK.TREE) {
        for (let i = 0; i < 6; i++) spawn('chip', x, y, z, nx * 3 + R() * 2, ny * 3 + R() * 2 + 1, nz * 3 + R() * 2);
        for (let i = 0; i < 3; i++) spawn('dust', x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * 1.2 + R() * 0.4, ny * 1.2 + R() * 0.4 + 0.2, nz * 1.2 + R() * 0.4);
        return;
      }
      if (struck === STRUCK.GROUND) {
        const kind = snowy ? 'snow' : 'dust';
        for (let i = 0; i < 6; i++) spawn(kind, x, y + 0.05, z, nx * 1.5 + R() * 0.9, 1.2 + Math.random() * 1.6, nz * 1.5 + R() * 0.9);
        for (let i = 0; i < 4; i++) spawn('chip', x, y + 0.03, z, R() * 1.5, 2 + Math.random() * 3, R() * 1.5);
      }
    },
    hole(x, y, z, nx, ny, nz) {
      Nrm.set(nx, ny, nz); Q.setFromUnitVectors(Z, Nrm); V.set(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01); S.setScalar(0.7 + Math.random() * 0.6);
      M.compose(V, Q, S); holes.setMatrixAt(holeN % HOLES, M); holeN++; holes.count = Math.min(HOLES, holeN); holes.instanceMatrix.needsUpdate = true;
    },
    update(dt, fog) {
      if (fog) { fogU.uFog.value.copy(fog.color); fogU.uFogNear.value = fog.near; fogU.uFogFar.value = fog.far; }
      for (const set of [soft, glow]) {
        const L = set.list; let w = 0;
        for (let i = 0; i < L.length; i++) {
          const p = L[i]; p.age += dt; if (p.age >= p.life) continue;
          const k = p.k, d = Math.exp(-k.drag * dt);
          p.vx *= d; p.vy = p.vy * d - k.grav * dt + k.lift * dt; p.vz *= d;
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          const fl = field.terrain.heightAt(p.x, p.z); if (p.y < fl) { p.y = fl; p.vy *= -0.2; p.vx *= 0.5; p.vz *= 0.5; }
          L[w++] = p;
        }
        L.length = w;
        for (let i = 0; i < w; i++) {
          const p = L[i], k = p.k, t = p.age / p.life, o = i * 3;
          set.pos[o] = p.x; set.pos[o + 1] = p.y; set.pos[o + 2] = p.z;
          set.col[o] = k.col[0]; set.col[o + 1] = k.col[1]; set.col[o + 2] = k.col[2];
          set.size[i] = p.s * (1 + k.grow * t);
          set.alpha[i] = (k.alpha || 1) * (k.add ? 1 - t : t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
        }
        set.geo.setDrawRange(0, w);
        for (const a of ['position', 'aCol', 'aSize', 'aAlpha']) set.geo.attributes[a].needsUpdate = true;
      }
      let n = 0;
      for (let i = 0; i < streaks.length; i++) {
        const s = streaks[i]; s.age += dt; if (s.age > 0.1) continue;
        const o = n * 6, f = 1 - s.age / 0.1;
        lpos[o] = s.x0; lpos[o + 1] = s.y0; lpos[o + 2] = s.z0; lpos[o + 3] = s.x1; lpos[o + 4] = s.y1; lpos[o + 5] = s.z1;
        lcol[o] = 0.15 * f; lcol[o + 1] = 0.12 * f; lcol[o + 2] = 0.08 * f; lcol[o + 3] = 0.9 * f; lcol[o + 4] = 0.75 * f; lcol[o + 5] = 0.45 * f;
        streaks[n++] = s;
      }
      streaks.length = n; lgeo.setDrawRange(0, n * 2); lgeo.attributes.position.needsUpdate = true; lgeo.attributes.color.needsUpdate = true;
    },
    get live() { return soft.list.length + glow.list.length; },
    dispose() { for (const o of [soft.pts, glow.pts, lines, holes]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); } },
  };
}
