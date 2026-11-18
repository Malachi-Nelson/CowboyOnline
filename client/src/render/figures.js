// People and horses, drawn for everyone at once with instancing: each body part is one instanced mesh, so a street
// full of riders is a dozen draw calls. They are box figures, but they move like their real counterparts, because
// how a body carries its weight is half of how movement feels: people stride, lean into a run and bank into a turn;
// horses walk, trot, canter and gallop with the right legs moving together, nod, pitch over rough ground and swish
// their tails; riders sit the horse and move with it.
import { THREE } from './three.js';
import { ST_GROUND, ST_RIDING, ST_WHISTLE, EF_BOT, KIND_HORSE, BAND_NEAR, BAND_MID, BAND_FAR } from '../../../shared/constants.js';
import { angTo } from '../../../shared/math.js';
import { Builder, C, mix } from './build.js';

const HIP = 0.86, SEAT = 1.6;
const COATS = [0x7a5a3c, 0x5f6b4a, 0x8a7350, 0x4f5d6b, 0x6b4a3f, 0x86806a, 0x5a4b61, 0x70614a, 0x3e3a36, 0x9a8a6a];
const HATS = [0x4a3a2a, 0x2e2622, 0x6b5a44, 0x8a7a62, 0x3a3430, 0x5a4636];
// coat, then mane and tail
const HORSES = [[0x6b3e22, 0x1e1712], [0x8a4b26, 0x6e3c1e], [0x2a221d, 0x16110e], [0x9c9690, 0x5a5550], [0xc49c5c, 0xe6d8b8], [0xae8650, 0x2a2018], [0x9c8660, 0x3a2e22], [0xd2ccc2, 0xbab2a2], [0x5a3a26, 0x241a14]];
const BANDS = [0x7fd08a, 0xe8c45a, 0xe2795a, 0x9a958c];
// leg order: left fore, right fore, left hind, right hind. Phase offsets, as a share of one stride, for each gait.
const GAITS = [
  { name: 'walk', top: 2.9, len: 1.75, offs: [0.25, 0.75, 0, 0.5], amp: 0.3, lift: 0.7, bob: 0.025, pitch: 0.01, nod: 0.07 },
  { name: 'trot', top: 5.8, len: 2.9, offs: [0, 0.5, 0.5, 0], amp: 0.42, lift: 1.0, bob: 0.06, pitch: 0.012, nod: 0.03 },
  { name: 'canter', top: 10.2, len: 3.6, offs: [0.38, 0.62, 0, 0.38], amp: 0.58, lift: 1.1, bob: 0.07, pitch: 0.07, nod: 0.12 },
  { name: 'gallop', top: 99, len: 5.6, offs: [0.5, 0.6, 0, 0.1], amp: 0.76, lift: 1.25, bob: 0.08, pitch: 0.06, nod: 0.1 },
];
const TAU = Math.PI * 2;

function parts() {
  const white = [1, 1, 1], P = {};
  // ---- people. Forward is -z. Each part is built about its own pivot.
  { const b = new Builder(); b.box(-0.22, 0, -0.125, 0.22, 0.62, 0.125, (x, y) => mix(C(0xdddddd), white, Math.min(1, y / 0.62))); b.box(-0.23, -0.06, -0.135, 0.23, 0.05, 0.135, C(0x6a5a4a)); P.torso = b.geometry(); }   // coat, and a belt
  { const b = new Builder(); b.box(-0.1, 0.02, -0.11, 0.1, 0.24, 0.04, C(0xc9a27e)); b.box(-0.105, 0.03, 0.03, 0.105, 0.25, 0.12, C(0x3a2c20)); b.box(-0.1, -0.06, -0.12, 0.1, 0.02, 0.05, C(0x8f2f25)); P.head = b.geometry(); }
  { const b = new Builder(); b.cyl(0, 0.2, 0.0, 0.3, 0.3, 0.03, 14, white, 'both'); b.cyl(0, 0.23, 0, 0.13, 0.15, 0.14, 10, white, true); b.cyl(0, 0.36, 0, 0.148, 0.148, 0.012, 10, C(0x777777), false); P.hat = b.geometry(); }
  { const b = new Builder(); b.box(-0.06, -0.56, -0.065, 0.06, 0.04, 0.065, (x, y) => mix(C(0xc8c8c8), white, Math.min(1, (y + 0.56) / 0.6))); b.box(-0.05, -0.68, -0.05, 0.05, -0.56, 0.05, C(0xc9a27e)); P.arm = b.geometry(); }
  { const b = new Builder(); b.box(-0.08, -0.66, -0.09, 0.08, 0, 0.09, C(0x3b3a3f)); b.box(-0.085, -0.86, -0.15, 0.085, -0.64, 0.1, C(0x2a211a)); P.leg = b.geometry(); }
  // ---- horses. Forward is -z, hooves at y = 0.
  {
    const b = new Builder(), coat = y => mix(C(0xb8b8b8), white, Math.min(1, Math.max(0, (y - 0.85) / 0.65)));
    b.box(-0.31, 0.85, -0.78, 0.31, 1.5, 0.74, (x, y) => coat(y));               // barrel
    b.box(-0.29, 0.92, -0.98, 0.29, 1.46, -0.7, (x, y) => coat(y));               // chest
    b.box(-0.33, 0.9, 0.5, 0.33, 1.53, 0.98, (x, y) => coat(y));                  // quarters
    P.body = b.geometry();
  }
  { const b = new Builder(); b.at(0, 0, 0, 0, -0.62); b.box(-0.15, -0.05, -0.2, 0.15, 0.84, 0.2, (x, y) => mix(C(0xdddddd), white, Math.min(1, y / 0.8))); b.pop(); P.neck = b.geometry(); }
  { const b = new Builder(); b.at(0, 0, 0, 0, -0.62); b.box(-0.05, 0.05, 0.12, 0.05, 0.9, 0.3, white); b.box(-0.05, 0.75, -0.12, 0.05, 0.98, 0.12, white); b.pop(); P.mane = b.geometry(); }
  {
    const b = new Builder(); b.at(0, 0, 0, 0, -0.95);                            // pointing down and forward from the poll
    b.box(-0.12, -0.13, -0.66, 0.12, 0.13, 0.04, (x, y, z) => mix(C(0x555555), white, Math.min(1, (z + 0.66) / 0.3 + 0.2)));
    b.pop();
    for (const s of [-1, 1]) { b.at(s * 0.07, 0.1, -0.02, 0, -0.25, s * 0.25); b.box(-0.03, 0, -0.03, 0.03, 0.16, 0.03, C(0xbbbbbb)); b.pop(); }   // ears
    P.hhead = b.geometry();
  }
  { const b = new Builder(); b.box(-0.085, -0.5, -0.1, 0.085, 0.05, 0.1, (x, y) => mix(C(0xc8c8c8), white, Math.min(1, (y + 0.5) / 0.5))); P.upper = b.geometry(); }
  { const b = new Builder(); b.box(-0.06, -0.42, -0.065, 0.06, 0.02, 0.065, C(0xb0b0b0)); b.box(-0.075, -0.52, -0.09, 0.075, -0.42, 0.075, C(0x262626)); P.lower = b.geometry(); }
  { const b = new Builder(); b.box(-0.055, -0.12, -0.05, 0.055, 0.05, 0.07, white);                  // the dock, then the hair falling from it, narrowing
    b.at(0, -0.08, 0.02, 0, 0.1); b.box(-0.06, -0.42, -0.045, 0.06, 0, 0.06, white); b.box(-0.045, -0.82, -0.035, 0.045, -0.4, 0.045, mix(white, C(0x999999), 0.3)); b.pop(); P.tail = b.geometry(); }
  {
    const b = new Builder(), leather = C(0x5a3a22), blanket = C(0x8a3a2c), stripe = C(0xd8c49a);
    b.box(-0.37, 1.47, -0.4, 0.37, 1.53, 0.36, blanket); b.box(-0.375, 1.3, -0.38, 0.375, 1.47, 0.34, (x, y, z) => ((z * 4 + 10) | 0) & 1 ? blanket : stripe, 't');
    b.box(-0.27, 1.53, -0.32, 0.27, 1.6, 0.3, leather); b.box(-0.23, 1.6, 0.16, 0.23, 1.7, 0.3, leather); b.box(-0.09, 1.6, -0.36, 0.09, 1.78, -0.24, leather);   // seat, cantle, horn
    for (const s of [-1, 1]) { b.box(s * 0.3 - 0.02, 0.98, -0.06, s * 0.3 + 0.02, 1.5, -0.02, leather); b.box(s * 0.3 - 0.06, 0.92, -0.1, s * 0.3 + 0.06, 0.98, 0.02, C(0x3a3836)); }   // stirrup leathers and irons
    b.box(-0.02, 1.3, -1.5, 0.02, 1.34, -0.4, leather, 'b');                    // the reins, up the neck
    P.saddle = b.geometry();
  }
  return P;
}

export function createFigures(scene, field, maxPeople = 110, maxHorses = 64) {
  const P = parts(), lit = () => new THREE.MeshLambertMaterial({ vertexColors: true });
  const all = [];
  const inst = (geo, n, tinted) => {
    const m = new THREE.InstancedMesh(geo, lit(), n); m.frustumCulled = false; m.count = 0; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (tinted) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);   // r128 sizes this from .count on first use, so make it now
    scene.add(m); all.push(m); return m;
  };
  const M = {
    torso: inst(P.torso, maxPeople, true), arm: inst(P.arm, maxPeople * 2, true), head: inst(P.head, maxPeople, true), hat: inst(P.hat, maxPeople, true), leg: inst(P.leg, maxPeople * 2, false),
    body: inst(P.body, maxHorses, true), neck: inst(P.neck, maxHorses, true), mane: inst(P.mane, maxHorses, true), hhead: inst(P.hhead, maxHorses, true), upper: inst(P.upper, maxHorses * 4, true), lower: inst(P.lower, maxHorses * 4, true), tail: inst(P.tail, maxHorses, true), saddle: inst(P.saddle, maxHorses, false),
  };
  // soft shadows under everyone
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g2 = cv.getContext('2d'), gr = g2.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
  const plane = new THREE.PlaneGeometry(1, 1); plane.rotateX(-Math.PI / 2);
  const shades = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), maxPeople + maxHorses);
  shades.frustumCulled = false; shades.count = 0; shades.renderOrder = 1; scene.add(shades); all.push(shades);

  const R = new THREE.Matrix4(), T = new THREE.Matrix4(), X = new THREE.Matrix4(), Hm = new THREE.Matrix4(), Am = new THREE.Matrix4(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), Nn = new THREE.Vector3();
  const col = new THREE.Color();
  let np = 0, nh = 0, ns = 0, env = null, sound = null, earX = 0, earZ = 0;
  const set = (m, i, mat, hex, k = 1) => { m.setMatrixAt(i, mat); if (hex !== undefined && m.instanceColor) m.setColorAt(i, col.setHex(hex).convertSRGBToLinear().multiplyScalar(k)); };
  const rotX = a => X.makeRotationX(a), rotZ = a => X.makeRotationZ(a);

  // a shadow on whatever is underfoot, tilted to the slope and stretched away from the light
  function shadow(x, y, z, yaw, w, l) {
    if (ns >= shades.instanceMatrix.count) return;
    const t = field.terrain, gy = field.groundAt(x, z, y + 0.3), high = Math.max(0, y - gy), k = 1 / (1 + high * 0.9);
    if (gy > t.heightAt(x, z) + 0.01) Nn.set(0, 1, 0); else Nn.set(t.heightAt(x - 0.5, z) - t.heightAt(x + 0.5, z), 1, t.heightAt(x, z - 0.5) - t.heightAt(x, z + 0.5)).normalize();
    const L = env ? env.light : UP, lay = Math.min(2.2, 0.45 / Math.max(0.2, L.y));
    Q.setFromUnitVectors(UP, Nn); Q2.setFromAxisAngle(UP, yaw); Q.multiply(Q2);
    V.set(x - L.x * lay * 0.4, gy + 0.03, z - L.z * lay * 0.4); S.set(w * k, 1, l * k);
    R.compose(V, Q, S); shades.setMatrixAt(ns++, R);
  }

  // ---- a horse. a: its animation state, carried from frame to frame. Leaves its body's matrix in a.M for the rider.
  function horse(a, x, y, z, yaw, speed, grounded, coat, dt, saddled) {
    if (nh >= maxHorses) return false;
    if (!a.init) { a.init = true; a.phase = Math.abs(x * 0.37 + z * 0.11) % 1; a.yaw = yaw; a.sp = speed; a.offs = GAITS[0].offs.slice(); a.amp = 0; a.lift = 0; a.g = 0; a.pitch = 0; a.roll = 0; a.idle = 0; a.graze = 0; a.tail = 0; a.th = [0, 0, 0, 0]; a.M = new THREE.Matrix4(); a.wet = 0; }
    const turn = angTo(a.yaw, yaw), k = 1 - Math.exp(-dt * 10);
    a.yaw += turn * k; a.sp += (speed - a.sp) * (1 - Math.exp(-dt * 6));
    const sp = Math.abs(a.sp), back = a.sp < -0.05;
    // which gait, with a little hysteresis, and ease the leg timing from one to the next
    let gi = a.g; while (gi < 3 && sp > GAITS[gi].top + 0.3) gi++; while (gi > 0 && sp < GAITS[gi - 1].top - 0.3) gi--; a.g = gi;
    const G = GAITS[gi], e = 1 - Math.exp(-dt * 5), moving = sp > 0.12;
    for (let i = 0; i < 4; i++) { let d = G.offs[i] - a.offs[i]; d -= Math.round(d); a.offs[i] += d * e; a.offs[i] -= Math.floor(a.offs[i]); }
    a.amp += ((moving ? G.amp * Math.min(1, sp / 1.2) : 0) - a.amp) * e; a.lift += ((moving ? G.lift : 0) - a.lift) * e;
    a.phase = (a.phase + (moving ? sp / G.len * dt * (back ? -1 : 1) : 0) + 10) % 1;
    const ph = a.phase * TAU, two = Math.sin(ph * 2), one = Math.sin(ph);
    // over rough ground the body follows the slope between fore and hind hooves
    const t = field.terrain, fx = Math.sin(a.yaw), fz = Math.cos(a.yaw), hf = t.heightAt(x - fx * 0.75, z - fz * 0.75), hb = t.heightAt(x + fx * 0.75, z + fz * 0.75);
    const slope = grounded ? Math.atan2(hf - hb, 1.5) : 0;
    a.pitch += (slope + (gi >= 2 ? one * G.pitch * a.amp / G.amp : 0) - a.pitch) * (1 - Math.exp(-dt * 12));
    a.roll += ((Math.max(-0.12, Math.min(0.12, turn * sp * 0.05))) - a.roll) * (1 - Math.exp(-dt * 6));
    const bob = moving ? (gi === 1 ? Math.abs(two) : gi >= 2 ? (one + 1) * 0.5 : (two + 1) * 0.5) * G.bob * Math.min(1, sp / 2) : 0;
    // idle: now and then the head goes down to graze
    a.idle = moving ? 0 : a.idle + dt; const graze = a.idle > 6 && ((a.idle / 9 + a.phase) % 1) > 0.45 ? 1 : 0; a.graze += (graze - a.graze) * (1 - Math.exp(-dt * 1.5));
    const water = t.levelAt(x, z) - y; a.wet = water;
    R.makeRotationY(a.yaw); R.multiply(rotX(a.pitch)); R.multiply(rotZ(a.roll)); R.setPosition(x, y + bob - (water > 1.2 ? Math.min(0.5, water - 1.2) : 0), z);
    a.M.copy(R);
    const [hc, mc] = HORSES[coat % HORSES.length];
    set(M.body, nh, R, hc);
    // neck and head: nod with the stride, stretch out at the gallop, drop to graze
    const nod = (gi >= 2 ? one : two) * G.nod * (a.amp / (G.amp || 1));
    const neckA = 0.0 - nod * 0.6 + (gi === 3 ? 0.28 : gi === 2 ? 0.12 : 0) * (sp / 13) + a.graze * 0.95;
    T.copy(R).multiply(X.makeTranslation(0, 1.38, -0.86)).multiply(rotX(-neckA));
    set(M.neck, nh, T, hc); set(M.mane, nh, T, mc);
    T.multiply(X.makeTranslation(0, 0.84 * Math.cos(0.62), -0.84 * Math.sin(0.62))).multiply(rotX(-nod * 0.5 + a.graze * 0.5));
    set(M.hhead, nh, T, hc);
    // legs: the upper leg swings from the shoulder or hip; the lower one folds back as the hoof comes forward
    for (let i = 0; i < 4; i++) {
      const fore = i < 2, side = i % 2 ? 1 : -1, th = (a.phase + a.offs[i]) * TAU, swing = Math.sin(th) * a.amp, fold = Math.max(0, Math.cos(th)) * a.lift * a.amp;
      T.copy(R).multiply(X.makeTranslation(side * 0.2, fore ? 1.02 : 1.05, fore ? -0.66 : 0.7)).multiply(rotX(swing + (fore ? 0 : 0.08)));
      set(M.upper, nh * 4 + i, T, hc);
      T.multiply(X.makeTranslation(0, -0.47, 0)).multiply(rotX(fore ? -fold * 1.3 : -fold * 0.8 - 0.1));
      set(M.lower, nh * 4 + i, T, hc);
      // a hoof coming down makes a sound, at the front of its swing
      if (sound && moving && grounded) {
        const prev = a.th[i], now = ((th % TAU) + TAU) % TAU, cross = prev < Math.PI / 2 && now >= Math.PI / 2;
        if (cross) { const d = Math.hypot(x - earX, z - earZ); if (d < 70) sound.hoof(gi, d, water > 0.1 ? 2 : field.groundAt(x, z, y + 0.3) > t.heightAt(x, z) + 0.05 ? 1 : t.maskAt(x, z, 0) > 0.5 || y > 190 ? 3 : 0); }
        a.th[i] = now;
      }
    }
    a.tail += ((gi >= 2 ? 0.9 : 0.15 + Math.sin(a.idle * 1.7 + a.phase * 9) * 0.12) - a.tail) * (1 - Math.exp(-dt * 4));
    T.copy(R).multiply(X.makeTranslation(0, 1.42, 0.98)).multiply(rotX(-a.tail)).multiply(rotZ(Math.sin(a.idle * 2.3) * 0.15 * (moving ? 0.3 : 1)));
    set(M.tail, nh, T, mc);
    if (saddled) set(M.saddle, nh, R); else { T.copy(R).multiply(X.makeScale(0.001, 0.001, 0.001)); set(M.saddle, nh, T); }
    shadow(x, y, z, a.yaw, 1.0, 2.6);
    nh++;
    return true;
  }

  // ---- a person on foot, or in the saddle when `seat` is a horse's matrix
  function person(a, x, y, z, yawWant, speedNow, grounded, coat, hat, dt, seat, whistle, gallop) {
    if (np >= maxPeople) return;
    if (!a.init) { a.init = true; a.phase = Math.abs(x * 7.3 + z * 3.1) % 6.28; a.yaw = yawWant; a.speed = speedNow; a.roll = 0; a.air = !grounded; a.wh = 0; a.ride = seat ? 1 : 0; }
    a.ride += ((seat ? 1 : 0) - a.ride) * (1 - Math.exp(-dt * 10));
    a.wh += ((whistle ? 1 : 0) - a.wh) * (1 - Math.exp(-dt * 12));
    if (seat) {
      R.copy(seat).multiply(X.makeTranslation(0, SEAT + 0.05 - HIP, 0.02));
      const lean = gallop ? 0.22 : 0.06;
      T.copy(R).multiply(X.makeTranslation(0, HIP, 0)).multiply(rotX(-lean));
      set(M.torso, np, T, coat);
      Hm.copy(T).multiply(X.makeTranslation(0, 0.62, 0)); set(M.head, np, Hm, 0xffffff, 0.92 + (coat % 7) * 0.02); set(M.hat, np, Hm, hat);
      for (let s = 0; s < 2; s++) {
        const side = s ? 1 : -1, wh = s ? a.wh : 0;
        Am.copy(T).multiply(X.makeTranslation(side * 0.28, 0.56, 0)).multiply(rotX(0.75 + wh * 1.4)).multiply(rotZ(-side * (0.15 + wh * 0.35)));
        set(M.arm, np * 2 + s, Am, coat);
        Am.copy(R).multiply(X.makeTranslation(side * 0.12, HIP, 0)).multiply(rotZ(side * 0.42)).multiply(rotX(0.42));
        set(M.leg, np * 2 + s, Am);
      }
      np++; return;
    }
    const turn = angTo(a.yaw, yawWant), k = 1 - Math.exp(-dt * 12);
    a.yaw += turn * k; a.speed += (speedNow - a.speed) * (1 - Math.exp(-dt * 9));
    a.roll += (Math.max(-0.22, Math.min(0.22, turn * a.speed * 0.09)) - a.roll) * (1 - Math.exp(-dt * 8));
    const sp = a.speed, moving = sp > 0.15, was = Math.cos(a.phase);
    if (moving && grounded) a.phase += sp * dt * Math.PI / (0.55 + 0.16 * sp);
    if (sound) {                                                   // a foot lands at the end of each swing, where the body is lowest
      const d = Math.hypot(x - earX, z - earZ);
      if (d < 40) { if (a.air && grounded) sound.land(d); else if (moving && grounded && was * Math.cos(a.phase) < 0) sound.step(sp, d); }
    }
    a.air = !grounded;
    const amp = grounded ? (moving ? Math.min(0.95, 0.22 + 0.11 * sp) : 0) : 0.5, sw = Math.sin(a.phase);
    const bob = grounded && moving ? Math.abs(Math.cos(a.phase)) * 0.045 * Math.min(1, sp / 3) : 0, lean = Math.min(0.24, sp * 0.034);
    // wading: the body sinks to the water, swimming leaves the head and shoulders out
    const water = field.terrain.levelAt(x, z) - y;
    R.makeRotationY(a.yaw); R.setPosition(x, y + bob, z);
    T.copy(R).multiply(X.makeTranslation(0, HIP, 0)).multiply(rotX(-lean)).multiply(rotZ(a.roll)).multiply(X.makeRotationY(sw * 0.07 * Math.min(1, sp / 3)));
    set(M.torso, np, T, coat);
    Hm.copy(T).multiply(X.makeTranslation(0, 0.62, 0)); set(M.head, np, Hm, 0xffffff, 0.92 + (coat % 7) * 0.02); set(M.hat, np, Hm, hat);
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1, legA = grounded ? sw * amp * side : (s ? 0.55 : -0.35), wh = s ? a.wh : 0;
      const armA = -legA * 0.75 * (1 - wh) + 2.3 * wh, armZ = -side * 0.06 * (1 - wh) - 0.5 * wh;
      Am.copy(T).multiply(X.makeTranslation(side * 0.28, 0.56, 0)).multiply(rotX(armA)).multiply(rotZ(armZ)); set(M.arm, np * 2 + s, Am, coat);
      Am.copy(R).multiply(X.makeTranslation(side * 0.115, HIP, 0)).multiply(rotX(legA)); set(M.leg, np * 2 + s, Am);
    }
    if (water < 0.3) shadow(x, y, z, a.yaw, 0.9, 1.25);
    np++;
  }

  const self = {}, selfHorse = {};
  return {
    count: () => np + nh,
    setField(f) { field = f; },
    // draw everyone the session knows about, and the player and their horse
    update(session, dt, bandTint, selfVisible, sounds, light) {
      np = 0; nh = 0; ns = 0; env = light || null;
      sound = sounds || null; earX = session.x; earZ = session.z; if (sound) sound.frame();
      const a = session.a, sh = session.horse;
      // horses first, so riders can sit on them
      if (a.h) horse(selfHorse, sh.x, sh.y, sh.z, sh.yaw, sh.sp, !!a.h.ground, session.id, dt, true);
      for (const e of session.ents.values()) {
        if (e.kind !== KIND_HORSE) continue;
        const an = e.anim || (e.anim = {}), sp = Math.hypot(e.vx, e.vz), fwd = Math.sin(e.yaw) * -e.vx + Math.cos(e.yaw) * -e.vz;
        horse(an, e.x, e.y, e.z, e.yaw, fwd < -0.3 ? -sp : sp, (e.st & ST_GROUND) !== 0, e.owner || e.id, dt, true);
      }
      const me = a.f;
      if (selfVisible) {
        const sp = Math.hypot(me.vx, me.vz);
        person(self, session.x, session.y, session.z, sp > 0.4 ? Math.atan2(-me.vx, -me.vz) : (self.init ? self.yaw : 0), sp, !!me.ground, 0xd8c9a2, HATS[0], dt, a.riding && a.h ? selfHorse.M : null, a.whT > 60, a.riding && a.h && a.h.sp > 9.5);
      }
      for (const e of session.ents.values()) {
        if (e.kind === KIND_HORSE) continue;
        const an = e.anim || (e.anim = {}), d = Math.hypot(e.x - session.x, e.z - session.z);
        const coat = bandTint ? BANDS[d < BAND_NEAR ? 0 : d < BAND_MID ? 1 : d < BAND_FAR ? 2 : 3] : (e.ef & EF_BOT) ? COATS[e.id % COATS.length] : 0xb5483a;
        const seat = (e.st & ST_RIDING) && e.mount && e.mount.anim && e.mount.anim.M ? e.mount.anim.M : null;
        person(an, e.x, e.y, e.z, e.yaw, Math.hypot(e.vx, e.vz), (e.st & ST_GROUND) !== 0, coat, HATS[e.id % HATS.length], dt, seat, (e.st & ST_WHISTLE) !== 0, seat && e.mount && Math.hypot(e.mount.vx, e.mount.vz) > 9.5);
      }
      M.torso.count = M.head.count = M.hat.count = np; M.arm.count = M.leg.count = np * 2;
      M.body.count = M.neck.count = M.mane.count = M.hhead.count = M.tail.count = M.saddle.count = nh; M.upper.count = M.lower.count = nh * 4;
      shades.count = ns;
      for (const m of all) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    },
    dispose() { for (const m of all) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } },
  };
}
