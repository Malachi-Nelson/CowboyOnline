// Trees, drawn from the same forest the server collides bodies with (shared/world/trees.js). Near the viewer each
// kind has a proper model; further out every tree is a few triangles, and past 420 m only every other one is drawn,
// a little bigger, which the eye does not notice at that range. Everything within 760 m is in one buffer per model,
// rebuilt when the viewer has moved 32 m. Two dozen draw calls at most, however big the forest.
import { THREE } from './three.js';
import { TREE, TREE_N, TREE_CELL, treeSize } from '../../../shared/world/trees.js';
import { Builder, C, mix } from './build.js';

const NEAR = 165, FAR = 760, THIN = 420, STEP = 32;
const NEAR2 = NEAR * NEAR, FAR2 = FAR * FAR, THIN2 = THIN * THIN;

function models() {
  const bark = C(0x4e3b2a), grey = C(0x8c8276), white = C(0xd9d6cc), cac = C(0x5e7c3c), cacDark = C(0x4b6630);
  const pine = [C(0x2c4628), C(0x355230), C(0x2f4a2b)], snow = C(0xe6ecf0);
  const near = {}, far = {};
  // pine: a trunk and three tiers, each a little darker underneath
  const conifer = (snowy, b = new Builder()) => {
    b.cyl(0, -0.3, 0, 0.28, 0.16, 3.6, 6, bark, false);
    [[1.6, 2.5, 4.4], [3.9, 2.0, 3.8], [6.2, 1.35, 3.4], [8.2, 0.7, 2.4]].forEach(([y, r, h], i) => {
      const g = pine[i % 3];
      b.cyl(0, y, 0, r, 0, h, 8, snowy ? (x, yy) => mix(g, snow, Math.min(1, Math.max(0, (yy - y - h * 0.15) / (h * 0.5)))) : (x, yy) => mix(mix(g, C(0x1e3020), 0.5), g, Math.min(1, (yy - y) / (h * 0.4))), false);
      b.cyl(0, y, 0, r, r * 0.35, 0.01, 8, C(0x1c2a1a), false);                             // a dark underside, for depth
    });
    return b.geometry();
  };
  near[TREE.PINE] = conifer(false); near[TREE.SNOWPINE] = conifer(true);
  // broadleaf: oak and cottonwood. A thick trunk, two limbs, a crown of lumps
  {
    const b = new Builder(), leaf = [C(0x52702f), C(0x5f7c34), C(0x48662b)];
    b.cyl(0, -0.3, 0, 0.42, 0.3, 3.6, 7, bark, false);
    b.at(0, 3, 0, 0, 0, 0.6); b.cyl(0, 0, 0, 0.18, 0.1, 2.2, 5, bark, false); b.pop();
    b.at(0, 3, 0, 2.1, 0, -0.55); b.cyl(0, 0, 0, 0.16, 0.1, 2.2, 5, bark, false); b.pop();
    b.blob(0, 5.4, 0, 2.9, 2.0, 2.9, leaf[0], 3); b.blob(1.5, 4.7, 0.8, 2.0, 1.6, 2.0, leaf[1], 5); b.blob(-1.4, 4.9, -0.9, 2.1, 1.6, 2.0, leaf[2], 7); b.blob(0.2, 6.6, -0.4, 1.8, 1.3, 1.8, leaf[1], 9);
    near[TREE.OAK] = b.geometry();
  }
  // aspen, in the hills: a pale slim trunk and a narrow crown
  {
    const b = new Builder(), leaf = C(0x8fa23f);
    b.cyl(0, -0.3, 0, 0.17, 0.1, 7, 6, white, false);
    for (let i = 0; i < 5; i++) b.cube(0, 0.9 + i * 1.1, 0.165, 0.2, 0.06, 0.02, C(0x2c2a26));
    b.blob(0, 5.6, 0, 1.4, 1.9, 1.4, leaf, 11); b.blob(0.3, 7.0, 0.2, 1.0, 1.3, 1.0, mix(leaf, C(0xc0a838), 0.3), 13);
    near[TREE.BIRCH] = b.geometry();
  }
  // bald cypress in the Mirewood: a flared foot, a tall bare trunk, a flat crown, moss hanging off it
  {
    const b = new Builder(), crown = C(0x4c5f36), moss = C(0x8a9278);
    b.cyl(0, -1.2, 0, 1.0, 0.36, 2.2, 7, mix(bark, grey, 0.4), false);
    b.cyl(0, 1.0, 0, 0.36, 0.22, 6.5, 6, mix(bark, grey, 0.4), false);
    b.blob(0, 8.0, 0, 3.4, 1.2, 3.4, crown, 17, 0.3); b.blob(1.2, 7.2, -0.8, 2.2, 0.9, 2.2, crown, 19, 0.3);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.4; b.cyl(Math.sin(a) * 2.1, 5.4, Math.cos(a) * 2.1, 0.02, 0.3, 2.2, 4, moss, false); }
    near[TREE.CYPRESS] = b.geometry();
  }
  // saguaro: a ribbed column and two arms
  {
    const b = new Builder();
    b.cyl(0, -0.2, 0, 0.32, 0.28, 4.6, 8, (x, y, z) => (Math.round(Math.atan2(x, z) / Math.PI * 4 + 8) & 1 ? cac : cacDark), false);
    b.cyl(0, 4.4, 0, 0.28, 0.0, 0.25, 8, cac, false);
    for (const [s, y0, len] of [[1, 1.8, 0.75], [-1, 2.5, 0.6]]) {
      b.at(s * 0.2, y0, 0, 0, 0, -s * Math.PI / 2); b.cyl(0, 0, 0, 0.2, 0.2, len, 6, cacDark, false); b.pop();
      b.cyl(s * (0.2 + len), y0 - 0.2, 0, 0.2, 0.17, 1.6, 6, cac, false); b.cyl(s * (0.2 + len), y0 + 1.4, 0, 0.17, 0, 0.18, 6, cac, false);
    }
    near[TREE.CACTUS] = b.geometry();
  }
  // a dead tree, grey and bare
  {
    const b = new Builder();
    b.cyl(0, -0.3, 0, 0.3, 0.12, 5.2, 6, grey, false);
    for (const [y, ry, rz, l] of [[2.4, 0.3, 0.8, 1.8], [3.3, 2.5, 0.7, 1.5], [4.0, 4.4, 0.6, 1.3], [1.7, 5.5, 1.0, 1.1]]) { b.at(0, y, 0, ry, 0, rz); b.cyl(0, 0, 0, 0.1, 0.03, l, 4, grey, false); b.pop(); }
    near[TREE.DEAD] = b.geometry();
  }
  // far: a cone, and a lump on a stick
  { const b = new Builder(); b.cyl(0, 0.5, 0, 2.3, 0, 9.6, 5, (x, y) => mix(C(0x253d24), C(0x355230), Math.min(1, y / 6)), false); far.conifer = b.geometry(); }
  { const b = new Builder(); b.cyl(0, 0, 0, 0.3, 0.2, 3.4, 4, bark, false); b.blob(0, 5.1, 0, 2.7, 2.1, 2.7, C(0x557230), 21, 0.15); far.broad = b.geometry(); }
  return { near, far };
}
const FAR_OF = { [TREE.PINE]: 'conifer', [TREE.SNOWPINE]: 'conifer', [TREE.OAK]: 'broad', [TREE.BIRCH]: 'broad', [TREE.CYPRESS]: 'broad' };

export function createTrees(scene, field) {
  const T = field.trees.T, tr = field.trees, ter = field.terrain, sd = field.seed | 0;
  const uni = { uTime: { value: 0 } };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // a little sway in the wind, more toward the top of the tree
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTime = uni.uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
          float k = max(transformed.y - 2.0, 0.0) * 0.022;
          transformed.x += sin(uTime * 1.3 + ph) * k; transformed.z += sin(uTime * 1.1 + ph * 1.7) * k * 0.7;
        #endif`);
  };
  const { near, far } = models(), meshes = {}, list = [];
  const make = (key, geo, cap, tint) => {
    const m = new THREE.InstancedMesh(geo, mat, cap); m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (tint) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    scene.add(m); meshes[key] = m; list.push(m); return m;
  };
  for (const k of Object.keys(near)) make('n' + k, near[k], 1600, false);
  make('fconifer', far.conifer, 16000, true); make('fbroad', far.broad, 9000, true);

  let cx = 1e9, cz = 1e9;
  // write one instance: turned about its trunk by `a`, scaled by s, standing at (x, y, z)
  const put = (m, x, y, z, a, s, sy, tint) => {
    const i = m.count; if (i >= m.instanceMatrix.count) return;
    const e = m.instanceMatrix.array, o = i * 16, c = Math.cos(a) * s, n = Math.sin(a) * s;
    e[o] = c; e[o + 1] = 0; e[o + 2] = -n; e[o + 3] = 0; e[o + 4] = 0; e[o + 5] = s * sy; e[o + 6] = 0; e[o + 7] = 0; e[o + 8] = n; e[o + 9] = 0; e[o + 10] = c; e[o + 11] = 0; e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
    if (tint !== undefined && m.instanceColor) { const q = m.instanceColor.array; q[i * 3] = tint; q[i * 3 + 1] = tint * (0.97 + (s % 0.06)); q[i * 3 + 2] = tint * 0.96; }
    m.count = i + 1;
  };
  function rebuild(x, z) {
    for (const m of list) m.count = 0;
    const c0 = Math.max(0, Math.floor((x - FAR) / TREE_CELL)), c1 = Math.min(TREE_N - 1, Math.floor((x + FAR) / TREE_CELL)), d0 = Math.max(0, Math.floor((z - FAR) / TREE_CELL)), d1 = Math.min(TREE_N - 1, Math.floor((z + FAR) / TREE_CELL));
    for (let j = d0; j <= d1; j++) for (let i = c0; i <= c1; i++) {
      const v = T[j * TREE_N + i]; if (!v) continue;
      const px = tr.posX(i, j), pz = tr.posZ(i, j), dx = px - x, dz = pz - z, d2 = dx * dx + dz * dz;
      if (d2 > FAR2) continue;
      const kind = v & 7, h = ((Math.imul(i, 2654435761) ^ Math.imul(j, 40503)) >>> 0), a = (h & 1023) / 1023 * 6.283, s = treeSize(v), sy = 0.9 + ((h >>> 10) & 255) / 255 * 0.25;
      const y = ter.heightAt(px, pz) - 0.1;
      if (d2 < NEAR2) { put(meshes['n' + kind], px, y, pz, a, s, sy); continue; }
      const fk = FAR_OF[kind]; if (!fk) continue;
      if (d2 > THIN2) { if (h & 0x100000) continue; put(meshes['f' + fk], px, y, pz, a, s * 1.18, sy, kind === TREE.SNOWPINE ? 1.45 : kind === TREE.BIRCH ? 1.25 : 0.92 + ((h >>> 18) & 15) / 100); }
      else put(meshes['f' + fk], px, y, pz, a, s, sy, kind === TREE.SNOWPINE ? 1.45 : kind === TREE.BIRCH ? 1.25 : 0.92 + ((h >>> 18) & 15) / 100);
    }
    for (const m of list) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    cx = x; cz = z;
  }
  void sd;
  return {
    update(x, z, time) {
      uni.uTime.value = time;
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > STEP * STEP) { rebuild(x, z); return true; }
      return false;
    },
    get drawn() { let n = 0; for (const m of list) n += m.count; return n; },
    dispose() { for (const m of list) { scene.remove(m); m.geometry.dispose(); } mat.dispose(); },
  };
}
