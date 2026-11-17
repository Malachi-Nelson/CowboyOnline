// The ground the player can see: an 800 m square of the terrain around them, read straight from the same height
// lattice the server walks bodies over, and moved along in 64 m steps as they travel. Phase 3 replaces this with
// streamed 128 m chunks and levels of detail; the shader's survey grid stays as a debug overlay.
import { THREE } from './three.js';
import { LAT, LAT_N } from '../../../shared/world/terrain.js';
import { HUB_X, HUB_Z, CHUNK } from '../../../shared/constants.js';

const CELLS = 200, STEP = 16;                 // 200 cells of 4 m = 800 m; re-centre every 16 cells (64 m)

export function createGround(scene, field) {
  const n = CELLS + 1, H = field.terrain.H;
  const geo = new THREE.BufferGeometry(), pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
  const idx = new Uint16Array(CELLS * CELLS * 6);
  for (let z = 0, k = 0; z < CELLS; z++) for (let x = 0; x < CELLS; x++) { const a = z * n + x, b = a + 1, c = a + n, d = c + 1; idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d; }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  // fine grain, so the ground is not one flat colour up close
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d'), img = g.createImageData(128, 128);
  let s = 1899; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 128 * 128; i++) { const v = 205 + rnd() * 50; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.97; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  const grain = new THREE.CanvasTexture(cv); grain.wrapS = grain.wrapT = THREE.RepeatWrapping; grain.anisotropy = 4;

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: grain });
  mat.extensions = { derivatives: true };
  const uni = { uGrid: { value: 1 }, uEye: { value: new THREE.Vector3() } };
  // A surveyor's grid drawn in the shader: a faint line every 8 m to judge speed by, and a stronger one every 128 m,
  // which is exactly the square the server sorts everything into to decide who can see whom.
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <uv_vertex>', 'vUv = position.xz * 0.125;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorld;\nuniform float uGrid;\nuniform vec3 uEye;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float dist = distance(vWorld.xz, uEye.xz);
          vec2 a = vWorld.xz / 8.0, b = vWorld.xz / ${CHUNK.toFixed(1)};
          vec2 ga = abs(fract(a - 0.5) - 0.5) / fwidth(a), gb = abs(fract(b - 0.5) - 0.5) / fwidth(b);
          float fine = (1.0 - min(min(ga.x, ga.y), 1.0)) * (1.0 - smoothstep(40.0, 150.0, dist));
          float cell = (1.0 - min(min(gb.x, gb.y) * 0.6, 1.0)) * (1.0 - smoothstep(250.0, 520.0, dist));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.015, 0.008), uGrid * fine * 0.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.6, 0.22), uGrid * cell * 0.6);
        }`);
  };
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; scene.add(mesh);

  const lin = h => new THREE.Color(h).convertSRGBToLinear();
  const dry = lin(0x9a8a4c), lush = lin(0x6f7d3e), rock = lin(0x7d6f5e), dirt = lin(0x9c8259), c = new THREE.Color();
  const h = (ix, iz) => H[(iz < 0 ? 0 : iz >= LAT_N ? LAT_N - 1 : iz) * LAT_N + (ix < 0 ? 0 : ix >= LAT_N ? LAT_N - 1 : ix)];
  let ox = -1e9, oz = -1e9;

  // (re)build the square around lattice cell (cx, cz)
  function build(cx, cz) {
    const x0 = cx - CELLS / 2, z0 = cz - CELLS / 2;
    for (let z = 0, i = 0; z < n; z++) for (let x = 0; x < n; x++, i += 3) {
      const ix = x0 + x, iz = z0 + z, y = h(ix, iz);
      pos[i] = x * LAT; pos[i + 1] = y; pos[i + 2] = z * LAT;
      const dx = (h(ix + 1, iz) - h(ix - 1, iz)) / (2 * LAT), dz = (h(ix, iz + 1) - h(ix, iz - 1)) / (2 * LAT), l = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      nor[i] = -dx * l; nor[i + 1] = l; nor[i + 2] = -dz * l;
      // colour: greener in the low ground, drier on the rises, bare on anything steep, worn at the hub
      const slope = 1 - l, wx = ix * LAT - HUB_X, wz = iz * LAT - HUB_Z, hub = Math.sqrt(wx * wx + wz * wz);
      const t = Math.min(1, Math.max(0, (y - 6) / 34)), v = ((ix * 73856093) ^ (iz * 19349663)) >>> 0;
      c.copy(lush).lerp(dry, t); if (slope > 0.015) c.lerp(rock, Math.min(1, (slope - 0.015) * 22));
      if (hub < 90) c.lerp(dirt, Math.min(1, (90 - hub) / 55) * 0.85);
      const k = 0.94 + (v % 1000) / 1000 * 0.12;
      col[i] = c.r * k; col[i + 1] = c.g * k; col[i + 2] = c.b * k;
    }
    geo.attributes.position.needsUpdate = geo.attributes.normal.needsUpdate = geo.attributes.color.needsUpdate = true;
    mesh.position.set(x0 * LAT, 0, z0 * LAT);
    ox = cx; oz = cz;
  }
  return {
    uni, mesh,
    // keep the square centred on the viewer; returns true when it moved
    update(x, z, eye) {
      uni.uEye.value.copy(eye);
      const cx = Math.round(x / LAT / STEP) * STEP, cz = Math.round(z / LAT / STEP) * STEP;
      if (cx === ox && cz === oz) return false;
      build(cx, cz); return true;
    },
  };
}
