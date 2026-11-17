// People, as placeholders: a hat, a head, a coat and two legs, drawn for everyone at once with instancing (three
// draw calls however many there are). They are stand-ins until HoodWar's figures are carried over in Phase 3, but
// they already stride, lean into a run and bank into a turn, because how a body carries its weight is part of how
// movement feels.
import { THREE } from './three.js';
import { ST_GROUND, EF_BOT, BAND_NEAR, BAND_MID, BAND_FAR } from '../../../shared/constants.js';
import { angTo, yawOf } from '../../../shared/math.js';
import { SUN_DIR } from './scene.js';

const HIP = 0.86;
const COATS = [0x7a5a3c, 0x5f6b4a, 0x8a7350, 0x4f5d6b, 0x6b4a3f, 0x86806a, 0x5a4b61, 0x70614a];
const BANDS = [0x7fd08a, 0xe8c45a, 0xe2795a, 0x9a958c];

function part(geo, color, m, out, shadeY) {
  const g = geo.index ? geo.toNonIndexed() : geo; g.applyMatrix4(m);
  const p = g.attributes.position, n = g.attributes.normal, c = new THREE.Color(color).convertSRGBToLinear();
  for (let i = 0; i < p.count; i++) {
    out.pos.push(p.getX(i), p.getY(i), p.getZ(i)); out.nor.push(n.getX(i), n.getY(i), n.getZ(i));
    const k = shadeY ? 0.88 + 0.12 * Math.min(1, Math.max(0, (p.getY(i) - shadeY[0]) / (shadeY[1] - shadeY[0]))) : 1;
    out.col.push(c.r * k, c.g * k, c.b * k);
  }
}
function build(parts) {
  const out = { pos: [], nor: [], col: [] }, m = new THREE.Matrix4();
  for (const [geo, color, x, y, z, shade] of parts) part(geo, color, m.makeTranslation(x, y, z), out, shade);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  return g;
}

export function createFigures(scene, field, max = 96) {
  // forward is -z. The coat is tinted per person; the rest is the same for everyone.
  const coat = build([
    [new THREE.BoxGeometry(0.44, 0.58, 0.25), 0xffffff, 0, 1.15, 0, [0.86, 1.44]],
    [new THREE.BoxGeometry(0.115, 0.56, 0.135), 0xdddddd, -0.28, 1.14, 0, [0.86, 1.44]],
    [new THREE.BoxGeometry(0.115, 0.56, 0.135), 0xdddddd, 0.28, 1.14, 0, [0.86, 1.44]],
  ]);
  const head = build([
    [new THREE.BoxGeometry(0.2, 0.22, 0.15), 0xc9a27e, 0, 1.56, -0.035],          // face
    [new THREE.BoxGeometry(0.21, 0.23, 0.09), 0x3a2c20, 0, 1.565, 0.075],          // hair
    [new THREE.BoxGeometry(0.2, 0.07, 0.03), 0x8f2f25, 0, 1.44, -0.13],            // neckerchief, at the front
    [new THREE.CylinderGeometry(0.3, 0.3, 0.03, 14), 0x4a3a2a, 0, 1.685, 0],       // brim
    [new THREE.CylinderGeometry(0.125, 0.15, 0.13, 12), 0x54422f, 0, 1.76, 0],     // crown
  ]);
  const leg = build([
    [new THREE.BoxGeometry(0.16, 0.66, 0.18), 0x3b3a3f, 0, -0.33, 0],
    [new THREE.BoxGeometry(0.17, 0.2, 0.26), 0x2a211a, 0, -0.76, -0.03],           // boot
  ]);
  const lit = () => new THREE.MeshLambertMaterial({ vertexColors: true });
  const coats = new THREE.InstancedMesh(coat, lit(), max), heads = new THREE.InstancedMesh(head, lit(), max), legs = new THREE.InstancedMesh(leg, lit(), max * 2);
  // soft shadow under each
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g2 = cv.getContext('2d'), gr = g2.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
  const plane = new THREE.PlaneGeometry(1, 1); plane.rotateX(-Math.PI / 2);
  const shades = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), max);
  coats.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);   // r128 sizes this from .count on first use, so make it now
  for (const m of [coats, heads, legs, shades]) { m.frustumCulled = false; m.count = 0; scene.add(m); }
  shades.renderOrder = 1;

  const M = new THREE.Matrix4(), A = new THREE.Matrix4(), B = new THREE.Matrix4(), C = new THREE.Color(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0), N = new THREE.Vector3(), P = new THREE.Vector3(), S = new THREE.Vector3();
  const sunYaw = Math.atan2(-SUN_DIR.x, -SUN_DIR.z);
  let n = 0, ox = 0, oz = 0;

  // one person: a = their animation state { phase, yaw, speed, roll, init }
  function put(a, x, y, z, yawWant, speedNow, grounded, color, dt) {
    if (n >= max) return;
    if (!a.init) { a.init = true; a.phase = (x * 7.3 + z * 3.1) % 6.28; a.yaw = yawWant; a.speed = speedNow; a.roll = 0; }
    const turn = angTo(a.yaw, yawWant), k = 1 - Math.exp(-dt * 12);
    a.yaw += turn * k; a.speed += (speedNow - a.speed) * (1 - Math.exp(-dt * 9));
    a.roll += (Math.max(-0.22, Math.min(0.22, turn * a.speed * 0.09)) - a.roll) * (1 - Math.exp(-dt * 8));
    const sp = a.speed, moving = sp > 0.15;
    if (moving && grounded) a.phase += sp * dt * Math.PI / (0.55 + 0.16 * sp);
    const amp = grounded ? (moving ? Math.min(0.95, 0.22 + 0.11 * sp) : 0) : 0.5, sw = Math.sin(a.phase);
    const bob = grounded && moving ? Math.abs(Math.cos(a.phase)) * 0.045 * Math.min(1, sp / 3) : 0, lean = Math.min(0.24, sp * 0.034);
    const lx = x - ox, lz = z - oz;

    // body: stand at (x, y, z), face yaw, lean forward into speed and bank into the turn
    M.makeRotationY(a.yaw); A.makeRotationX(-lean); M.multiply(A); A.makeRotationZ(a.roll); M.multiply(A);
    B.makeRotationY(sw * 0.07 * Math.min(1, sp / 3)); A.copy(M).multiply(B);
    // lean about the hips, not the feet
    P.set(0, HIP, 0).applyMatrix4(M); const hx = lx - P.x, hy = y + bob + HIP - P.y, hz = lz - P.z;
    A.setPosition(hx, hy, hz); coats.setMatrixAt(n, A); coats.setColorAt(n, C.setHex(color).convertSRGBToLinear());
    M.setPosition(hx, hy, hz); heads.setMatrixAt(n, M);
    // legs swing from the hip, opposite each other; tucked a little in the air
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1, ang = grounded ? sw * amp * side : (s ? 0.55 : -0.35);
      A.makeRotationY(a.yaw); B.makeTranslation(side * 0.115, 0, 0); A.multiply(B); B.makeRotationX(ang); A.multiply(B);
      P.set(side * 0.115, 0, 0).applyMatrix4(B.makeRotationY(a.yaw));
      A.setPosition(lx + P.x, y + bob + HIP, lz + P.z); legs.setMatrixAt(n * 2 + s, A);
    }
    // shadow: on whatever is underfoot, tilted to the slope, stretched away from the sun, fainter with height
    const t = field.terrain.heightAt(x, z), gy = field.groundAt(x, z, y), high = Math.max(0, y - gy), size = 1.05 / (1 + high * 0.9);
    if (gy > t + 0.01) N.set(0, 1, 0); else N.set(field.terrain.heightAt(x - 0.5, z) - field.terrain.heightAt(x + 0.5, z), 1, field.terrain.heightAt(x, z - 0.5) - field.terrain.heightAt(x, z + 0.5)).normalize();
    Q.setFromUnitVectors(UP, N); Q2.setFromAxisAngle(UP, sunYaw); Q.multiply(Q2);
    P.set(lx - SUN_DIR.x * 0.35, gy + 0.03, lz - SUN_DIR.z * 0.35); S.set(size * 0.85, 1, size * 1.5);
    M.compose(P, Q, S); shades.setMatrixAt(n, M);
    n++;
  }

  const self = {};
  return {
    count: () => n,
    // draw everyone the session knows about, and the player
    update(session, dt, bandTint, selfVisible) {
      n = 0; ox = Math.round(session.x); oz = Math.round(session.z);
      for (const m of [coats, heads, legs, shades]) m.position.set(ox, 0, oz);
      const me = session.me;
      if (selfVisible) {
        const sp = Math.hypot(me.vx, me.vz);
        put(self, session.x, session.y, session.z, sp > 0.4 ? yawOf(me.vx, me.vz) : (self.init ? self.yaw : 0), sp, !!me.ground, 0xd8c9a2, dt);
      }
      for (const e of session.ents.values()) {
        const a = e.anim || (e.anim = {}), d = Math.hypot(e.x - session.x, e.z - session.z);
        const color = bandTint ? BANDS[d < BAND_NEAR ? 0 : d < BAND_MID ? 1 : d < BAND_FAR ? 2 : 3] : (e.ef & EF_BOT) ? COATS[e.id % COATS.length] : 0xb5483a;
        put(a, e.x, e.y, e.z, e.yaw, Math.hypot(e.vx, e.vz), (e.st & ST_GROUND) !== 0, color, dt);
      }
      coats.count = heads.count = shades.count = n; legs.count = n * 2;
      for (const m of [coats, heads, legs, shades]) m.instanceMatrix.needsUpdate = true;
      if (coats.instanceColor) coats.instanceColor.needsUpdate = true;
    },
  };
}
