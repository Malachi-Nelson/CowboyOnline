// People and horses, drawn for everyone at once with instancing: each body part is one instanced mesh, so a street
// full of riders is a dozen draw calls. They are box figures, but they move like their real counterparts, because
// how a body carries its weight is half of how movement feels: people stride, lean into a run and bank into a turn;
// horses walk, trot, canter and gallop with the right legs moving together, nod, pitch over rough ground and swish
// their tails; riders sit the horse and move with it.
import { THREE } from './three.js';
import { ST_GROUND, ST_RIDING, ST_WHISTLE, EF_BOT, EF_LAW, KIND_HORSE, BAND_NEAR, BAND_MID, BAND_FAR, GR_SLOT, GR_AIM, GR_RELOAD, GR_HANDS, GR_DEAD } from '../../../shared/constants.js';
import { ZONE } from '../../../shared/net/messages.js';
import { GF } from '../../../shared/sim/guns.js';
import { angTo } from '../../../shared/math.js';
import { HORSE } from '../../../shared/sim/moveHorse.js';
import { Builder, C, mix } from './build.js';

const HIP = 0.86, SEAT = 1.6, GALLOPING = 10;   // a rider leans forward above this speed (m/s)
const COATS = [0x7a5a3c, 0x5f6b4a, 0x8a7350, 0x4f5d6b, 0x6b4a3f, 0x86806a, 0x5a4b61, 0x70614a, 0x3e3a36, 0x9a8a6a];
const HATS = [0x4a3a2a, 0x2e2622, 0x6b5a44, 0x8a7a62, 0x3a3430, 0x5a4636];
const LAW_COAT = 0x30343e, LAW_HAT = 0x1c1a18;
// coat, then mane and tail
const HORSES = [[0x6b3e22, 0x1e1712], [0x8a4b26, 0x6e3c1e], [0x2a221d, 0x16110e], [0x9c9690, 0x5a5550], [0xc49c5c, 0xe6d8b8], [0xae8650, 0x2a2018], [0x9c8660, 0x3a2e22], [0xd2ccc2, 0xbab2a2], [0x5a3a26, 0x241a14]];
const BANDS = [0x7fd08a, 0xe8c45a, 0xe2795a, 0x9a958c];
// leg order: left fore, right fore, left hind, right hind. Phase offsets, as a share of one stride, for each gait.
const GAITS = [
  { name: 'walk', top: 2.9, len: 1.75, offs: [0.25, 0.75, 0, 0.5], amp: 0.3, lift: 0.7, bob: 0.025, pitch: 0.01, nod: 0.07 },
  { name: 'trot', top: 5.8, len: 2.9, offs: [0, 0.5, 0.5, 0], amp: 0.42, lift: 1.0, bob: 0.06, pitch: 0.012, nod: 0.03 },
  { name: 'canter', top: 10.2, len: 3.6, offs: [0.38, 0.62, 0, 0.38], amp: 0.58, lift: 1.1, bob: 0.07, pitch: 0.07, nod: 0.12 },
  { name: 'gallop', top: 99, len: 0, offs: [0.5, 0.6, 0, 0.1], amp: 0.76, lift: 1.25, bob: 0.08, pitch: 0.06, nod: 0.1 },   // stride lengthens with speed: see strideOf
];
const TAU = Math.PI * 2;
// metres a stride: a galloping horse covers more ground with each stride as it goes faster, about 6.8 m at full speed
const strideOf = (G, sp) => G.len || 4.4 + sp * 0.14;

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
  // ---- guns, built along -z from the hand (the grip at the origin), and a lawman's star
  {
    const b = new Builder(), steel = C(0x3c3d40), dark = C(0x232325), grip = C(0x6b4426);
    b.box(-0.018, -0.02, -0.24, 0.018, 0.012, -0.05, steel);                    // barrel
    b.box(-0.032, -0.03, -0.08, 0.032, 0.03, 0.0, dark);                         // cylinder
    b.box(-0.02, -0.025, 0.0, 0.02, 0.025, 0.035, steel);                        // frame and hammer
    b.at(0, -0.02, 0.02, -0.5, 0, 0); b.box(-0.017, -0.11, -0.02, 0.017, 0.0, 0.02, grip); b.pop();
    P.revolver = b.geometry();
  }
  {
    const b = new Builder(), steel = C(0x3a3b3e), wood = C(0x7a4e2a), brass = C(0xb08a3c);
    b.box(-0.014, -0.012, -0.78, 0.014, 0.014, -0.12, steel);                   // barrel
    b.box(-0.02, -0.03, -0.62, 0.02, -0.006, -0.16, steel);                     // magazine tube under it
    b.box(-0.026, -0.045, -0.16, 0.026, 0.03, 0.04, brass);                     // receiver
    b.box(-0.022, -0.06, -0.44, 0.022, -0.01, -0.16, wood);                     // forend
    b.at(0, -0.02, 0.04, -0.18, 0, 0); b.box(-0.026, -0.1, 0.0, 0.026, 0.035, 0.36, wood); b.pop();   // stock
    b.box(-0.006, -0.1, -0.02, 0.006, -0.045, 0.06, steel);                     // lever
    P.rifle = b.geometry();
  }
  { const b = new Builder(); b.box(-0.04, -0.04, -0.012, 0.04, 0.04, 0.0, C(0xd8b24a)); P.badge = b.geometry(); }
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
    revolver: inst(P.revolver, maxPeople, false), rifle: inst(P.rifle, maxPeople, false), badge: inst(P.badge, 24, false),
  };
  // soft shadows under everyone
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g2 = cv.getContext('2d'), gr = g2.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
  const plane = new THREE.PlaneGeometry(1, 1); plane.rotateX(-Math.PI / 2);
  const shades = new THREE.InstancedMesh(plane, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), maxPeople + maxHorses);
  shades.frustumCulled = false; shades.count = 0; shades.renderOrder = 1; scene.add(shades); all.push(shades);

  const R = new THREE.Matrix4(), T = new THREE.Matrix4(), X = new THREE.Matrix4(), Hm = new THREE.Matrix4(), Am = new THREE.Matrix4(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), Nn = new THREE.Vector3();
  const col = new THREE.Color();
  let np = 0, nh = 0, ns = 0, nr = 0, nf = 0, nb = 0, env = null, sound = null, earX = 0, earZ = 0;
  const G = new THREE.Matrix4(), muzzle = new THREE.Vector3();
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
    if (!a.init) { a.init = true; a.phase = Math.abs(x * 0.37 + z * 0.11) % 1; a.yaw = yaw; a.sp = speed; a.offs = GAITS[0].offs.slice(); a.amp = 0; a.lift = 0; a.g = 0; a.pitch = 0; a.roll = 0; a.idle = 0; a.graze = 0; a.tail = 0; a.th = [0, 0, 0, 0]; a.M = new THREE.Matrix4(); a.wet = 0; a.py = y; a.vy = 0; a.air = 0; a.up = false; }
    // off the ground (a jump, or over a drop): judged by height above whatever is underneath, so other people's horses,
    // drawn a little in the past, leave the ground when their bodies do and not when the news that they jumped arrives
    const under = Math.max(field.groundAt(x, z, y, HORSE.step), field.terrain.levelAt(x, z) - HORSE.swimAt), up = y - under > 0.15;
    grounded = !up;
    a.vy += (Math.max(-12, Math.min(12, dt > 0 ? (y - a.py) / dt : 0)) - a.vy) * (1 - Math.exp(-dt * 14)); a.py = y;
    a.air += ((up ? 1 : 0) - a.air) * (1 - Math.exp(-dt * (up ? 16 : 10)));
    const u = Math.max(-1, Math.min(1, a.vy / 6));                // +1 rising hard, -1 coming down hard
    const turn = angTo(a.yaw, yaw), k = 1 - Math.exp(-dt * 10);
    a.yaw += turn * k; a.sp += (speed - a.sp) * (1 - Math.exp(-dt * 6));
    const sp = Math.abs(a.sp), back = a.sp < -0.05;
    // which gait, with a little hysteresis, and ease the leg timing from one to the next
    let gi = a.g; while (gi < 3 && sp > GAITS[gi].top + 0.3) gi++; while (gi > 0 && sp < GAITS[gi - 1].top - 0.3) gi--; a.g = gi;
    const G = GAITS[gi], e = 1 - Math.exp(-dt * 5), moving = sp > 0.12;
    for (let i = 0; i < 4; i++) { let d = G.offs[i] - a.offs[i]; d -= Math.round(d); a.offs[i] += d * e; a.offs[i] -= Math.floor(a.offs[i]); }
    a.amp += ((moving ? G.amp * Math.min(1, sp / 1.2) : 0) - a.amp) * e; a.lift += ((moving ? G.lift : 0) - a.lift) * e;
    a.phase = (a.phase + (moving ? sp / strideOf(G, sp) * dt * (back ? -1 : 1) : 0) + 10) % 1;
    const ph = a.phase * TAU, two = Math.sin(ph * 2), one = Math.sin(ph);
    // over rough ground the body follows the slope between fore and hind hooves
    const t = field.terrain, fx = Math.sin(a.yaw), fz = Math.cos(a.yaw), hf = t.heightAt(x - fx * 0.75, z - fz * 0.75), hb = t.heightAt(x + fx * 0.75, z + fz * 0.75);
    const slope = grounded ? Math.atan2(hf - hb, 1.5) : 0;
    a.pitch += (slope + (gi >= 2 ? one * G.pitch * a.amp / G.amp : 0) * (1 - a.air) + a.air * u * 0.32 - a.pitch) * (1 - Math.exp(-dt * 12));
    a.roll += ((Math.max(-0.12, Math.min(0.12, turn * sp * 0.05))) - a.roll) * (1 - Math.exp(-dt * 6));
    const bob = moving && !up ? (gi === 1 ? Math.abs(two) : gi >= 2 ? (one + 1) * 0.5 : (two + 1) * 0.5) * G.bob * Math.min(1, sp / 2) : 0;
    // idle: now and then the head goes down to graze
    a.idle = moving ? 0 : a.idle + dt; const graze = a.idle > 6 && ((a.idle / 9 + a.phase) % 1) > 0.45 ? 1 : 0; a.graze += (graze - a.graze) * (1 - Math.exp(-dt * 1.5));
    const water = t.levelAt(x, z) - y; a.wet = water;
    R.makeRotationY(a.yaw); R.multiply(rotX(a.pitch)); R.multiply(rotZ(a.roll)); R.setPosition(x, y + bob - (water > 1.2 ? Math.min(0.5, water - 1.2) : 0), z);
    a.M.copy(R); a.yawNow = a.yaw;
    const [hc, mc] = HORSES[coat % HORSES.length];
    set(M.body, nh, R, hc);
    // neck and head: nod with the stride, stretch out at the gallop, drop to graze
    const nod = (gi >= 2 ? one : two) * G.nod * (a.amp / (G.amp || 1));
    const neckA = 0.0 - nod * 0.6 * (1 - a.air) + (gi === 3 ? 0.28 : gi === 2 ? 0.12 : 0) * Math.min(1.1, sp / 15) + a.graze * 0.95 + a.air * (0.22 - 0.12 * u);
    T.copy(R).multiply(X.makeTranslation(0, 1.38, -0.86)).multiply(rotX(-neckA));
    set(M.neck, nh, T, hc); set(M.mane, nh, T, mc);
    T.multiply(X.makeTranslation(0, 0.84 * Math.cos(0.62), -0.84 * Math.sin(0.62))).multiply(rotX(-nod * 0.5 + a.graze * 0.5));
    set(M.hhead, nh, T, hc);
    // legs: the upper leg swings from the shoulder or hip; the lower one folds back as the hoof comes forward
    for (let i = 0; i < 4; i++) {
      const fore = i < 2, side = i % 2 ? 1 : -1, th = (a.phase + a.offs[i]) * TAU, swing = Math.sin(th) * a.amp, fold = Math.max(0, Math.cos(th)) * a.lift * a.amp;
      let ua = swing + (fore ? 0 : 0.08), la = fore ? -fold * 1.3 : -fold * 0.8 - 0.1;
      if (a.air > 0.01) {                                         // in the air: forelegs tucked going up and reaching for the ground coming down; hind legs trailing, then gathered under
        const ja = fore ? 0.6 + 0.5 * u : -0.7 * u + side * 0.04, jl = fore ? -(1.15 + 0.75 * u) : -(0.7 - 0.35 * u);
        ua += (ja - ua) * a.air; la += (jl - la) * a.air;
      }
      T.copy(R).multiply(X.makeTranslation(side * 0.2, fore ? 1.02 : 1.05, fore ? -0.66 : 0.7)).multiply(rotX(ua));
      set(M.upper, nh * 4 + i, T, hc);
      T.multiply(X.makeTranslation(0, -0.47, 0)).multiply(rotX(la));
      set(M.lower, nh * 4 + i, T, hc);
      // a hoof coming down makes a sound, at the front of its swing
      if (sound && moving && grounded) {
        const prev = a.th[i], now = ((th % TAU) + TAU) % TAU, cross = prev < Math.PI / 2 && now >= Math.PI / 2;
        if (cross) { const d = Math.hypot(x - earX, z - earZ); if (d < 70) sound.hoof(gi, d, water > 0.1 ? 2 : field.groundAt(x, z, y + 0.3) > t.heightAt(x, z) + 0.05 ? 1 : t.maskAt(x, z, 0) > 0.5 || y > 190 ? 3 : 0); }
        a.th[i] = now;
      }
    }
    a.tail += ((gi >= 2 || up ? 0.9 + a.air * 0.25 : 0.15 + Math.sin(a.idle * 1.7 + a.phase * 9) * 0.12) - a.tail) * (1 - Math.exp(-dt * 4));
    // the push off and the landing are heard
    if (sound && up !== a.up && (moving || !up)) {
      const d = Math.hypot(x - earX, z - earZ), surf = water > 0.1 ? 2 : field.groundAt(x, z, y + 0.3) > t.heightAt(x, z) + 0.05 ? 1 : t.maskAt(x, z, 0) > 0.5 || y > 190 ? 3 : 0;
      if (d < 80) { if (up) sound.hoof(3, d, surf); else sound.thud(d, surf, Math.min(1, -a.vy / 9)); }
    }
    a.up = up;
    T.copy(R).multiply(X.makeTranslation(0, 1.42, 0.98)).multiply(rotX(-a.tail)).multiply(rotZ(Math.sin(a.idle * 2.3) * 0.15 * (moving ? 0.3 : 1)));
    set(M.tail, nh, T, mc);
    if (saddled) set(M.saddle, nh, R); else { T.copy(R).multiply(X.makeScale(0.001, 0.001, 0.001)); set(M.saddle, nh, T); }
    shadow(x, y, z, a.yaw, 1.0, 2.6);
    nh++;
    return true;
  }

  // ---- a person on foot, or in the saddle when `seat` is a horse's matrix
  // The pose of the gun arm (right) and the other arm, as rotations about x and z, for someone holding a gun.
  // aimP: the pitch they aim at. Fills arm[0..3]: right x, right z, left x, left z.
  const arm = [0, 0, 0, 0];
  function gunArms(slot, aimK, relK, aimP) {
    const up = Math.PI / 2 + aimP;
    // lowered: revolver at the side, rifle across the body; aimed: the right arm out along the line and the left
    // reaching in to meet it (under the revolver's grip, or the rifle's fore-end)
    const rx0 = slot === 2 ? 0.55 : 0.2, rz0 = slot === 2 ? 0.1 : -0.06, lx0 = slot === 2 ? 0.95 : 0.1, lz0 = slot === 2 ? -0.62 : 0.06;
    const rx1 = up, rz1 = slot === 2 ? 0.05 : 0.02, lx1 = up + (slot === 2 ? 0.1 : -0.08), lz1 = slot === 2 ? 0.52 : 0.66;
    arm[0] = rx0 + (rx1 - rx0) * aimK; arm[1] = rz0 + (rz1 - rz0) * aimK; arm[2] = lx0 + (lx1 - lx0) * aimK; arm[3] = lz0 + (lz1 - lz0) * aimK;
    if (relK > 0.01) { arm[0] += (0.95 - arm[0]) * relK; arm[1] += (0.25 - arm[1]) * relK; arm[2] += (1.1 - arm[2]) * relK; arm[3] += (-0.75 - arm[3]) * relK; }
  }
  // a gun in the right hand: Am is that arm's matrix
  function drawGun(slot, kick) {
    G.copy(Am).multiply(X.makeTranslation(0, -0.62, 0)).multiply(rotX(-Math.PI / 2 + kick));
    if (slot === 1) M.revolver.setMatrixAt(nr++, G); else M.rifle.setMatrixAt(nf++, G);
  }

  // seat: the horse's animation state (its body's matrix is seat.M), when the person is riding.
  // o: { gear, pitch, aimYaw, law, hurt } — what they hold and how, which way they aim, and how lately they were hit
  function person(a, x, y, z, yawWant, speedNow, grounded, coat, hat, dt, seat, whistle, gallop, o) {
    if (np >= maxPeople) return;
    const gear = o ? o.gear : 0, slot = gear & GR_SLOT, aiming = (gear & GR_AIM) !== 0 && slot !== 0, dead = (gear & GR_DEAD) !== 0, law = o && o.law;
    if (!a.init) { a.init = true; a.phase = Math.abs(x * 7.3 + z * 3.1) % 6.28; a.yaw = yawWant; a.speed = speedNow; a.roll = 0; a.air = !grounded; a.wh = 0; a.ride = seat ? 1 : 0; a.aimK = 0; a.relK = 0; a.hands = 0; a.fall = dead ? 1 : 0; a.limp = 0; a.clutch = 0; a.kick = 0; a.twist = 0; }
    a.ride += ((seat ? 1 : 0) - a.ride) * (1 - Math.exp(-dt * 10));
    a.wh += ((whistle ? 1 : 0) - a.wh) * (1 - Math.exp(-dt * 12));
    a.aimK += ((aiming ? 1 : 0) - a.aimK) * (1 - Math.exp(-dt * 14)); a.relK += (((gear & GR_RELOAD) && slot ? 1 : 0) - a.relK) * (1 - Math.exp(-dt * 10));
    a.hands += ((gear & GR_HANDS ? 1 : 0) - a.hands) * (1 - Math.exp(-dt * 8));
    a.kick *= Math.exp(-dt * 18);
    // hit: lean away from the shot, more for a body shot; a leg makes them limp a while; a body shot, clutch at it
    const hurt = o && o.hurt ? o.hurt : 0, hz = o ? o.hurtZone : 0;
    if (hurt > 0.95) { if (hz === ZONE.LEGS) a.limp = 3.5; else if (hz === ZONE.BODY) a.clutch = 1.6; }
    a.limp = Math.max(0, a.limp - dt); a.clutch = Math.max(0, a.clutch - dt);
    if (law) coat = LAW_COAT;
    if (dead) {                                                     // falling, then lying where they fell
      if (a.fall === 0) { a.deadYaw = a.yaw; a.fallSide = (o && o.hurtYaw !== undefined && Math.cos((o.hurtYaw || 0) - a.yaw) > 0) ? -1 : 1; }
      a.fall = Math.min(1, a.fall + dt * 2.4);
      const f = a.fall * a.fall * (3 - 2 * a.fall), back = a.fallSide || 1;
      R.makeRotationY(a.deadYaw); R.setPosition(x, y + 0.14 * f, z); R.multiply(rotX(back * f * 1.5));
      T.copy(R).multiply(X.makeTranslation(0, HIP * (1 - f * 0.2), 0));
      set(M.torso, np, T, coat);
      Hm.copy(T).multiply(X.makeTranslation(0, 0.62, 0)).multiply(rotX(back * 0.3 * f)); set(M.head, np, Hm, 0xffffff, 0.92 + (coat % 7) * 0.02);
      Hm.multiply(X.makeTranslation(0, -0.05 * f, back * 0.35 * f)); set(M.hat, np, Hm, law ? LAW_HAT : hat);
      for (let s = 0; s < 2; s++) {
        const side = s ? 1 : -1;
        Am.copy(T).multiply(X.makeTranslation(side * 0.28, 0.56, 0)).multiply(rotZ(-side * 1.25 * f)).multiply(rotX(back * 0.3 * f)); set(M.arm, np * 2 + s, Am, coat);
        Am.copy(R).multiply(X.makeTranslation(side * 0.115, HIP, 0)).multiply(rotZ(side * 0.18 * f)).multiply(rotX(-back * 0.1 * f)); set(M.leg, np * 2 + s, Am);
      }
      if (law && nb < M.badge.instanceMatrix.count) { G.copy(T).multiply(X.makeTranslation(-0.12, 0.45, -0.13)); M.badge.setMatrixAt(nb++, G); }
      shadow(x, y, z, a.deadYaw, 1.1, 1.9);
      np++; return;
    }
    a.fall = 0;
    if (seat) {
      R.copy(seat.M).multiply(X.makeTranslation(0, SEAT + 0.05 - HIP + seat.air * 0.08, 0.02 - seat.air * 0.08));
      const lean = (gallop ? 0.22 : 0.06) * (1 - a.aimK) + seat.air * 0.3;            // up out of the saddle and forward over the neck for a jump
      // aiming from the saddle: the body turns at the waist toward the aim, as far as it can
      let tw = 0; if (o && a.aimK > 0.01) { tw = Math.atan2(Math.sin(o.aimYaw - seat.yawNow), Math.cos(o.aimYaw - seat.yawNow)); tw = Math.max(-1.7, Math.min(1.7, tw)); }
      a.twist += (tw * a.aimK - a.twist) * (1 - Math.exp(-dt * 12));
      T.copy(R).multiply(X.makeTranslation(0, HIP, 0)).multiply(X.makeRotationY(a.twist)).multiply(rotX(-lean + hurt * 0.25));
      set(M.torso, np, T, coat);
      Hm.copy(T).multiply(X.makeTranslation(0, 0.62, 0)); set(M.head, np, Hm, 0xffffff, 0.92 + (coat % 7) * 0.02); set(M.hat, np, Hm, law ? LAW_HAT : hat);
      if (slot) gunArms(slot, a.aimK, a.relK, (o ? o.pitch : 0) + lean);
      for (let s = 0; s < 2; s++) {
        const side = s ? 1 : -1, wh = s ? a.wh : 0;
        if (slot && (s === 1 || a.aimK > 0.3 || a.relK > 0.3)) Am.copy(T).multiply(X.makeTranslation(side * 0.28, 0.56, 0)).multiply(rotX(s ? arm[0] + a.kick : arm[2])).multiply(rotZ(s ? arm[1] : arm[3]));
        else Am.copy(T).multiply(X.makeTranslation(side * 0.28, 0.56, 0)).multiply(rotX(0.75 + wh * 1.4)).multiply(rotZ(-side * (0.15 + wh * 0.35)));
        set(M.arm, np * 2 + s, Am, coat);
        if (s === 1 && slot) drawGun(slot, a.kick);
        Am.copy(R).multiply(X.makeTranslation(side * 0.12, HIP, 0)).multiply(rotZ(side * 0.42)).multiply(rotX(0.42));
        set(M.leg, np * 2 + s, Am);
      }
      if (law && nb < M.badge.instanceMatrix.count) { G.copy(T).multiply(X.makeTranslation(-0.12, 0.45, -0.13)); M.badge.setMatrixAt(nb++, G); }
      np++; return;
    }
    const turn = angTo(a.yaw, yawWant), k = 1 - Math.exp(-dt * (a.aimK > 0.5 ? 20 : 12));
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
    const limp = a.limp > 0 ? Math.min(1, a.limp) : 0;
    const bob = grounded && moving ? Math.abs(Math.cos(a.phase)) * 0.045 * Math.min(1, sp / 3) * (1 + limp * 1.5) : 0, lean = Math.min(0.24, sp * 0.034) * (1 - a.aimK * 0.7);
    // wading: the body sinks to the water, swimming leaves the head and shoulders out
    const water = field.terrain.levelAt(x, z) - y;
    // a hit throws the upper body away from the shot for a moment
    let pushX = 0, pushZ = 0;
    if (hurt > 0.01 && o) { const rel = o.hurtYaw - a.yaw; pushX = -Math.sin(rel) * hurt; pushZ = -Math.cos(rel) * hurt; }
    R.makeRotationY(a.yaw); R.setPosition(x, y + bob - (hz === ZONE.LEGS ? hurt * 0.12 : 0), z);
    T.copy(R).multiply(X.makeTranslation(0, HIP, 0)).multiply(rotX(-lean - pushZ * 0.4)).multiply(rotZ(a.roll + pushX * 0.35 + (limp ? Math.sin(a.phase) * 0.07 * limp : 0))).multiply(X.makeRotationY(sw * 0.07 * Math.min(1, sp / 3) * (1 - a.aimK)));
    set(M.torso, np, T, coat);
    Hm.copy(T).multiply(X.makeTranslation(0, 0.62, 0)); if (hz === ZONE.HEAD && hurt > 0.01) Hm.multiply(rotX(-pushZ * 0.6)).multiply(rotZ(pushX * 0.5));
    set(M.head, np, Hm, 0xffffff, 0.92 + (coat % 7) * 0.02); set(M.hat, np, Hm, law ? LAW_HAT : hat);
    if (slot) gunArms(slot, a.aimK, a.relK, o ? o.pitch : 0);
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1, legA = grounded ? sw * amp * side * (limp && s ? 1 - limp * 0.55 : 1) : (s ? 0.55 : -0.35), wh = s ? a.wh : 0;
      let armA = -legA * 0.75 * (1 - wh) + 2.3 * wh, armZ = -side * 0.06 * (1 - wh) - 0.5 * wh;
      if (slot && (s === 1 || a.aimK > 0.05 || a.relK > 0.05 || slot === 2)) { armA = s ? arm[0] + a.kick : arm[2]; armZ = s ? arm[1] : arm[3]; }
      else if (!s && a.clutch > 0) { const c = Math.min(1, a.clutch * 2); armA = armA * (1 - c) + 0.75 * c; armZ = armZ * (1 - c) - 1.0 * c; }   // a hand to the wound
      if (a.hands > 0.01) { armA += (Math.PI - 0.25 - armA) * a.hands; armZ += (-side * 0.3 - armZ) * a.hands; }
      Am.copy(T).multiply(X.makeTranslation(side * 0.28, 0.56, 0)).multiply(rotX(armA)).multiply(rotZ(armZ)); set(M.arm, np * 2 + s, Am, coat);
      if (s === 1 && slot) drawGun(slot, a.kick);
      Am.copy(R).multiply(X.makeTranslation(side * 0.115, HIP, 0)).multiply(rotX(legA)); set(M.leg, np * 2 + s, Am);
    }
    if (law && nb < M.badge.instanceMatrix.count) { G.copy(T).multiply(X.makeTranslation(-0.12, 0.45, -0.13)); M.badge.setMatrixAt(nb++, G); }
    if (water < 0.3) shadow(x, y, z, a.yaw, 0.9, 1.25);
    np++;
  }

  const self = {}, selfHorse = {}, selfO = { gear: 0, pitch: 0, aimYaw: 0, law: false, hurt: 0, hurtZone: 0, hurtYaw: 0 }, remO = { gear: 0, pitch: 0, aimYaw: 0, law: false, hurt: 0, hurtZone: 0, hurtYaw: 0 };
  return {
    count: () => np + nh,
    setField(f) { field = f; },
    // a shot's kick, on someone's gun arm (or the player's own)
    kick(an) { if (an) an.kick = 0.45; },
    kickSelf() { self.kick = 0.45; },
    // draw everyone the session knows about, and the player and their horse. me: { aiming, aimYaw, pitch, hurt, hurtZone, hurtYaw }
    update(session, dt, bandTint, selfVisible, sounds, light, me) {
      np = 0; nh = 0; ns = 0; nr = 0; nf = 0; nb = 0; env = light || null;
      sound = sounds || null; earX = session.x; earZ = session.z; if (sound) sound.frame();
      const a = session.a, sh = session.horse;
      // horses first, so riders can sit on them
      if (a.h) horse(selfHorse, sh.x, sh.y, sh.z, sh.yaw, sh.sp, !!a.h.ground, session.id, dt, true);
      for (const e of session.ents.values()) {
        if (e.kind !== KIND_HORSE) continue;
        const an = e.anim || (e.anim = {}), sp = Math.hypot(e.vx, e.vz), fwd = Math.sin(e.yaw) * -e.vx + Math.cos(e.yaw) * -e.vz;
        horse(an, e.x, e.y, e.z, e.yaw, fwd < -0.3 ? -sp : sp, (e.st & ST_GROUND) !== 0, e.owner || e.id, dt, true);
      }
      const f = a.f;
      if (selfVisible) {
        const sp = Math.hypot(f.vx, f.vz), aimUp = me && me.aiming && a.slot && !a.swap;
        selfO.gear = (a.swap ? 0 : a.slot) | (aimUp ? GR_AIM : 0) | (a.rel > 0 ? GR_RELOAD : 0) | (a.gfl & GF.HANDS ? GR_HANDS : 0) | (a.dead ? GR_DEAD : 0);
        selfO.pitch = me ? me.pitch : 0; selfO.aimYaw = me ? me.aimYaw : 0; selfO.hurt = me ? me.hurt : 0; selfO.hurtZone = me ? me.hurtZone : 0; selfO.hurtYaw = me ? me.hurtYaw : 0;
        person(self, session.x, session.y, session.z, aimUp && !a.riding ? me.aimYaw : sp > 0.4 ? Math.atan2(-f.vx, -f.vz) : (self.init ? self.yaw : 0), sp, !!f.ground, 0xd8c9a2, HATS[0], dt, a.riding && a.h ? selfHorse : null, a.whT > 60, a.riding && a.h && a.h.sp > GALLOPING, selfO);
      }
      for (const e of session.ents.values()) {
        if (e.kind === KIND_HORSE) continue;
        const an = e.anim || (e.anim = {}), d = Math.hypot(e.x - session.x, e.z - session.z);
        const coat = bandTint ? BANDS[d < BAND_NEAR ? 0 : d < BAND_MID ? 1 : d < BAND_FAR ? 2 : 3] : (e.ef & EF_BOT) ? COATS[e.id % COATS.length] : 0xb5483a;
        const seat = (e.st & ST_RIDING) && e.mount && e.mount.anim && e.mount.anim.M ? e.mount.anim : null;
        if (e.hurt > 0) e.hurt = Math.max(0, e.hurt - dt * 2.5);
        remO.gear = e.gear; remO.pitch = 0; remO.aimYaw = e.aimYaw; remO.law = (e.ef & EF_LAW) !== 0; remO.hurt = e.hurt; remO.hurtZone = e.hurtZone; remO.hurtYaw = e.hurtYaw;
        person(an, e.x, e.y, e.z, e.yaw, Math.hypot(e.vx, e.vz), (e.st & ST_GROUND) !== 0, coat, HATS[e.id % HATS.length], dt, seat, (e.st & ST_WHISTLE) !== 0, seat && e.mount && Math.hypot(e.mount.vx, e.mount.vz) > GALLOPING, remO);
      }
      M.torso.count = M.head.count = M.hat.count = np; M.arm.count = M.leg.count = np * 2;
      M.revolver.count = nr; M.rifle.count = nf; M.badge.count = nb;
      M.body.count = M.neck.count = M.mane.count = M.hhead.count = M.tail.count = M.saddle.count = nh; M.upper.count = M.lower.count = nh * 4;
      shades.count = ns;
      for (const m of all) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    },
    dispose() { for (const m of all) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } },
  };
}
