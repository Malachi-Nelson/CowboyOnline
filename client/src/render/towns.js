// Everything built: the shops, houses, barns, church and adobes of the towns, their porches and signs, the street
// furniture, the bridge, and the telegraph line along the roads. Drawn from the same records the server collides
// with (shared/world/towns.js), so a post on screen is a post you walk into.
//
// Each building is put together in its own frame (front wall on z = 0 facing +z, the building behind it, width
// along +x) and then turned to face its street. Walls, roofs and trim are one mesh, glass is another (it lights up
// after dark), and signs a third, painted onto one canvas.
import { THREE } from './three.js';
import { Builder, C, mix } from './build.js';

const WALL = [0xd6cdb9, 0x8c7b66, 0x8e3d2d, 0x8a9a9e, 0xc49c4c, 0x5f4633, 0x7c8a69, 0xb88b7b, 0xe4ddcf, 0xd8ccb0, 0xc99a6a, 0xbf8a6d];
const TRIM = [0xece6d6, 0x4a3828, 0xece6d6, 0xece6d6, 0x5a3e28, 0xd8ccb6, 0xece6d6, 0xece6d6, 0x6a5038, 0x8a7a60, 0x6e4a2c, 0x6e4a2c];
const ROOF = [0x4b4038, 0x5d4a3b, 0x6f6c66, 0x4b4038, 0x3f3a36];
const WOOD = C(0x7a6046), DARKWOOD = C(0x4a3626), PLANK = C(0x8a6e50), IRON = C(0x3a3836), WATER = C(0x2d4c56), STONE = C(0x8a8478);

// windows: glass that the shader lights from inside after dark
const GLASS_VERT = `attribute float lit; varying float vLit;
#include <fog_pars_vertex>
void main() { vLit = lit; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const GLASS_FRAG = `uniform float uNight; uniform vec3 uGlass; varying float vLit;
#include <fog_pars_fragment>
void main() { vec3 lamp = vec3(0.95, 0.5, 0.17) * (0.62 + 0.3 * vLit); gl_FragColor = vec4(mix(uGlass, lamp, step(0.5, vLit) * uNight), 1.0);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
  #include <fog_fragment>
}`;

export function createTowns(scene, field) {
  const b = new Builder(), g = new Builder(), sg = new Builder(true);
  g.extra = [];
  const signs = [];                                             // { text, w, h }: painted onto the atlas once everything is known
  let lcg = 1; const rnd = () => ((lcg = (lcg * 16807) % 2147483647) / 2147483647);

  // a window or door opening: frame in the main mesh, glass in the lit one
  const win = (x0, y0, x1, y1, trim, lit, z = 0) => {
    b.box(x0 - 0.09, y0 - 0.09, z - 0.02, x1 + 0.09, y1 + 0.09, z + 0.05, trim);
    g.quad([x0, y0, z + 0.055], [x1, y0, z + 0.055], [x1, y1, z + 0.055], [x0, y1, z + 0.055], [0, 0, 0], null, lit);
    if (x1 - x0 > 0.7) b.box((x0 + x1) / 2 - 0.03, y0, z + 0.05, (x0 + x1) / 2 + 0.03, y1, z + 0.07, trim, 'bns');   // a glazing bar
  };
  const P = m => { b.push(m); g.push(m); }, Q = () => { b.pop(); g.pop(); };
  const turned = (x, z, ry) => new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(ry));
  const door = (x0, x1, h, wood, trim) => { b.box(x0 - 0.1, 0, -0.02, x1 + 0.1, h + 0.1, 0.05, trim); b.box(x0, 0, 0.05, x1, h, 0.07, wood, 'b'); };
  const sign = (text, x0, x1, y0, y1, z) => { if (!text) return; signs.push({ text, w: x1 - x0, h: y1 - y0, quad: [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], m: b.m.clone() }); };
  // a boardwalk with posts and an awning over it, along the whole front
  const porch = (w, pd, roofC, posts = true, top = 3.0) => {
    b.box(0, -0.6, 0, w, 0.3, pd, [PLANK, DARKWOOD, DARKWOOD]);
    if (!posts) return;
    const n = Math.max(2, Math.round(w / 3.4) + 1);
    for (let i = 0; i < n; i++) { const px = 0.1 + (w - 0.36) * i / (n - 1) + 0.08; b.box(px - 0.08, 0.3, pd - 0.16, px + 0.08, top - 0.1, pd, WOOD); }
    b.push(new THREE.Matrix4().makeTranslation(w / 2, top, pd / 2 + 0.1).multiply(new THREE.Matrix4().makeRotationX(0.08)));
    b.box(-w / 2 - 0.15, -0.05, -pd / 2 - 0.25, w / 2 + 0.15, 0.05, pd / 2 + 0.3, [roofC, DARKWOOD, DARKWOOD], '');
    b.pop();
  };

  function shop(o, w, d) {
    const wall = C(WALL[o.tone]), trim = C(TRIM[o.tone]), roof = C(ROOF[o.seed % ROOF.length]), H = o.h - 0.3, top = H + o.front;
    b.box(0, -0.6, -d, w, H, 0, [wall, wall, wall]);
    b.gableZ(-0.25, w + 0.25, -d - 0.3, -0.2, H, H + w * 0.22, roof); b.gableEndsZ(0, w, H, H + w * 0.22 - 0.04, -d, null, mix(wall, C(0x000000), 0.15));
    // the false front: taller than the roof, so from the street it looks like a bigger building than it is
    b.box(-0.05, H - 0.3, -0.18, w + 0.05, top, 0.04, [trim, mix(wall, C(0xffffff), 0.08), wall]);
    b.box(-0.22, top, -0.32, w + 0.22, top + 0.2, 0.2, trim, '');
    if (o.seed & 1) { b.box(w * 0.32, top + 0.2, -0.18, w * 0.68, top + 0.75, 0.04, [trim, mix(wall, C(0xffffff), 0.08), wall]); b.box(w * 0.3, top + 0.75, -0.28, w * 0.7, top + 0.92, 0.14, trim, ''); }
    // ground floor: a door in the middle, shop windows either side
    const dx = w / 2;
    door(dx - 0.65, dx + 0.65, 2.35, DARKWOOD, trim);
    if (w > 6) { win(0.55, 0.75, dx - 1.0, 2.45, trim, rnd() < 0.7 ? 1 : 0); win(dx + 1.0, 0.75, w - 0.55, 2.45, trim, rnd() < 0.7 ? 1 : 0); }
    for (let s = 1; s < o.storeys; s++) {                     // upper floors: a row of sash windows
      const y0 = s * 3.6 + 0.9, n = Math.max(2, Math.floor(w / 3));
      for (let i = 0; i < n; i++) { const cx = (i + 0.5) * w / n; win(cx - 0.42, y0, cx + 0.42, y0 + 1.5, trim, rnd() < 0.5 ? 1 : 0); }
    }
    for (const side of [0, 1]) for (let i = 0; i < Math.floor(d / 5); i++) {   // side windows
      P(turned(side ? w : 0, -2.5 - i * 5, side ? Math.PI / 2 : -Math.PI / 2)); win(-0.45, 1.0, 0.45, 2.3, trim, rnd() < 0.4 ? 1 : 0); Q();
    }
    if (o.porch > 0) porch(w, o.porch, roof, true, o.storeys > 1 ? 3.3 : 3.0);
    sign(o.sign, w * 0.1, w * 0.9, H + 0.08, H + Math.min(o.front, 1.05) - 0.05, 0.06);
    if (o.seed & 2) b.cyl(w * 0.7, H + w * 0.1, -d * 0.6, 0.12, 0.12, 1.6, 6, IRON, true);   // a stovepipe
  }
  function house(o, w, d) {
    const wall = C(WALL[o.tone]), trim = C(TRIM[o.tone]), roof = C(ROOF[o.seed % ROOF.length]), H = o.h - 0.4, pitch = o.kind === 'house' ? 0.55 : 0.5;
    b.box(0, -0.6, -d, w, H, 0, wall);
    b.gable(-0.35, w + 0.35, -d - 0.4, 0.4, H - 0.05, H + d * pitch / 2, roof, null);
    b.push(new THREE.Matrix4().makeTranslation(0, 0, -d / 2));
    b.tri([w, H - 0.05, d / 2], [w, H - 0.05, -d / 2], [w, H - 0.05 + d * pitch / 2, 0], wall); b.tri([0, H - 0.05, -d / 2], [0, H - 0.05, d / 2], [0, H - 0.05 + d * pitch / 2, 0], wall);
    b.pop();
    door(w / 2 - 0.5, w / 2 + 0.5, 2.2, DARKWOOD, trim);
    win(w * 0.18, 1.0, w * 0.18 + 1.0, 2.2, trim, rnd() < 0.65 ? 1 : 0); win(w * 0.82 - 1.0, 1.0, w * 0.82, 2.2, trim, rnd() < 0.65 ? 1 : 0);
    for (let s = 1; s < o.storeys; s++) for (const cx of [w * 0.3, w * 0.7]) win(cx - 0.4, s * 3.6 + 0.9, cx + 0.4, s * 3.6 + 2.2, trim, rnd() < 0.5 ? 1 : 0);
    if (o.porch > 0) {
      b.box(0, -0.6, 0, w, 0.3, o.porch, [PLANK, DARKWOOD, DARKWOOD]);
      const n = Math.max(2, Math.round(w / 3.4) + 1);
      for (let i = 0; i < n; i++) { const px = 0.1 + (w - 0.36) * i / (n - 1) + 0.08; b.box(px - 0.08, 0.3, o.porch - 0.16, px + 0.08, 2.75, o.porch, WOOD); }
      b.push(new THREE.Matrix4().makeTranslation(w / 2, 2.85, o.porch / 2).multiply(new THREE.Matrix4().makeRotationX(0.18)));
      b.box(-w / 2 - 0.1, -0.05, -o.porch / 2 - 0.1, w / 2 + 0.1, 0.05, o.porch / 2 + 0.25, [roof, DARKWOOD, DARKWOOD], ''); b.pop();
    }
    b.box(w * 0.82, H, -d * 0.55, w * 0.82 + 0.6, H + d * pitch / 2 + 0.9, -d * 0.55 + 0.6, STONE);   // chimney
    sign(o.sign, w * 0.15, w * 0.85, H - 0.85, H - 0.1, 0.05);
  }
  function barn(o, w, d) {
    const wall = C(WALL[o.tone]), trim = C(0xe8e0cc), roof = C(0x4a3a30), H = o.h - 0.6, ridge = H + w * 0.42;
    b.box(0, -0.6, -d, w, H, 0, wall);
    b.gableZ(-0.4, w + 0.4, -d - 0.4, 0.35, H - 0.1, ridge, roof); b.gableEndsZ(0, w, H - 0.1, ridge - 0.12, -d, 0, wall);
    // big doors, with a loft door in the gable above
    const dx = w / 2; b.box(dx - 2.1, 0, -0.02, dx + 2.1, 3.7, 0.05, trim); b.box(dx - 1.95, 0, 0.05, dx + 1.95, 3.55, 0.08, mix(wall, C(0x000000), 0.25), 'b');
    for (const s of [-1, 1]) { b.push(new THREE.Matrix4().makeTranslation(dx + s * 0.98, 1.78, 0.1).multiply(new THREE.Matrix4().makeRotationZ(s * 0.98))); b.box(-0.06, -2.2, 0, 0.06, 2.2, 0.03, trim, ''); b.pop(); }
    b.box(dx - 0.85, H + 0.4, -0.02, dx + 0.85, H + 1.9, 0.06, mix(wall, C(0x000000), 0.3));
    b.box(dx - 0.1, ridge - 0.5, 0.2, dx + 0.1, ridge - 0.3, 1.4, DARKWOOD);       // the hay hoist
    if (o.porch > 0) porch(w, o.porch, roof, true, 3.0);
    sign(o.sign, dx - Math.min(w * 0.42, 5.5), dx + Math.min(w * 0.42, 5.5), 3.85, 4.75, 0.08);
  }
  function church(o, w, d) {
    const wall = C(0xece6d8), trim = C(0x7a6a58), roof = C(0x3f3a36), H = o.h, ridge = H + w * 0.6;
    b.box(0, -0.6, -d, w, H, 0, wall);
    b.gableZ(-0.3, w + 0.3, -d - 0.3, 0.3, H - 0.05, ridge, roof); b.gableEndsZ(0, w, H - 0.05, ridge - 0.1, -d, 0, wall);
    for (const side of [0, 1]) for (let i = 0; i < 3; i++) { P(turned(side ? w : 0, -3.5 - i * 4.5, side ? Math.PI / 2 : -Math.PI / 2)); win(-0.45, 1.6, 0.45, 4.2, trim, rnd() < 0.5 ? 1 : 0); Q(); }
    // the steeple, over the door
    const t0 = w / 2 - 1.3, t1 = w / 2 + 1.3;
    b.box(t0, H, -2.6, t1, ridge + 2.6, 0.05, wall); b.box(t0 - 0.15, ridge + 2.6, -2.75, t1 + 0.15, ridge + 2.85, 0.2, trim, '');
    b.box(t0 + 0.4, ridge + 0.8, -0.02, t1 - 0.4, ridge + 2.1, 0.08, C(0x2a2622));
    b.push(new THREE.Matrix4().makeTranslation(w / 2, ridge + 2.85, -1.3).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 4)));
    b.cyl(0, 0, 0, 1.85, 0, 5.2, 4, roof, false); b.pop();
    b.box(w / 2 - 0.05, ridge + 7.9, -1.35, w / 2 + 0.05, ridge + 9.1, -1.25, IRON); b.box(w / 2 - 0.35, ridge + 8.6, -1.35, w / 2 + 0.35, ridge + 8.7, -1.25, IRON);
    door(w / 2 - 0.8, w / 2 + 0.8, 2.8, DARKWOOD, trim);
    b.box(w / 2 - 1.5, -0.6, 0, w / 2 + 1.5, 0.3, 1.4, STONE);                  // the step
  }
  function adobe(o, w, d) {
    const wall = C(WALL[o.tone]), trim = C(TRIM[o.tone]), H = o.h - 0.2, par = o.front || 0.6;
    b.box(0, -0.6, -d, w, H + par, 0, [mix(wall, C(0xffffff), 0.06), wall, wall]);
    b.box(0.35, H, -d + 0.35, w - 0.35, H + par - 0.05, -0.35, mix(wall, C(0x000000), 0.18), 'b');   // the roof sits inside the parapet
    for (let x = 0.5; x < w - 0.3; x += 0.85) b.cyl(x, H - 0.45, 0.25, 0.09, 0.09, 0.18, 5, DARKWOOD, true);
    for (let x = 0.5; x < w - 0.3; x += 0.85) { b.push(new THREE.Matrix4().makeTranslation(x, H - 0.35, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))); b.cyl(0, 0, 0, 0.09, 0.09, 0.45, 5, DARKWOOD, true); b.pop(); }   // vigas: roof beams through the wall
    door(w / 2 - 0.55, w / 2 + 0.55, 2.2, C(0x5c3a22), trim);
    for (const cx of [w * 0.2, w * 0.8]) if (w > 7) win(cx - 0.4, 1.0, cx + 0.4, 1.9, trim, rnd() < 0.6 ? 1 : 0);
    for (let s = 1; s < o.storeys; s++) for (const cx of [w * 0.25, w * 0.5, w * 0.75]) win(cx - 0.35, s * 3.6 + 1.0, cx + 0.35, s * 3.6 + 2.0, trim, rnd() < 0.5 ? 1 : 0);
    if (o.porch > 0) {                                          // a ramada: posts and a flat roof of poles
      b.box(0, -0.6, 0, w, 0.3, o.porch, [C(0xa58a6a), C(0x7a6450), C(0x7a6450)]);
      const n = Math.max(2, Math.round(w / 3.4) + 1);
      for (let i = 0; i < n; i++) { const px = 0.1 + (w - 0.36) * i / (n - 1) + 0.08; b.box(px - 0.08, 0.3, o.porch - 0.16, px + 0.08, 2.75, o.porch, DARKWOOD); }
      b.box(-0.1, 2.75, -0.1, w + 0.1, 2.9, o.porch + 0.1, [C(0x8a7458), DARKWOOD, DARKWOOD], '');
    }
    sign(o.sign, w * 0.15, w * 0.85, H - 0.2 + par * 0.15, H + par - 0.12, 0.05);
  }
  function tent(o, w, d) {
    const canvas = C(0xd9ccad), H = o.h;
    b.gableZ(-0.1, w + 0.1, -d, 0, 0, H, canvas); b.gableEndsZ(-0.1, w + 0.1, 0, H, -d, null, canvas);
    b.tri([w / 2 - 0.5, 0, 0.01], [w / 2 + 0.5, 0, 0.01], [w / 2, H * 0.75, 0.01], C(0x3a3028));
  }

  // ---- each building, in its own frame and then turned to face its street
  for (const o of field.buildings) {
    const along = o.face === 's' || o.face === 'n', w = along ? o.x1 - o.x0 : o.z1 - o.z0, d = along ? o.z1 - o.z0 : o.x1 - o.x0;
    const [ax, az, ry] = o.face === 's' ? [o.x0, o.z1, 0] : o.face === 'n' ? [o.x1, o.z0, Math.PI] : o.face === 'e' ? [o.x1, o.z1, Math.PI / 2] : [o.x0, o.z0, -Math.PI / 2];
    lcg = 1 + o.seed;
    P(new THREE.Matrix4().makeTranslation(ax, o.y, az).multiply(new THREE.Matrix4().makeRotationY(ry)));
    ({ shop, barn, house, church, adobe, tent })[o.kind](o, w, d);
    Q();
  }

  // ---- street furniture
  for (const p of field.props) {
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, lx = p.x1 - p.x0, lz = p.z1 - p.z0, y = p.y;
    if (p.kind === 'rail') { const ax = lx > lz; for (const s of [-1, 1]) b.cube(cx + (ax ? s * (lx / 2 - 0.06) : 0), y + 0.5, cz + (ax ? 0 : s * (lz / 2 - 0.06)), 0.12, 1.1, 0.12, WOOD); b.cube(cx, y + 0.98, cz, ax ? lx : 0.1, 0.1, ax ? 0.1 : lz, WOOD); }
    else if (p.kind === 'trough') { b.box(p.x0, y - 0.2, p.z0, p.x1, y + p.h, p.z1, WOOD); b.box(p.x0 + 0.08, y + p.h - 0.12, p.z0 + 0.08, p.x1 - 0.08, y + p.h - 0.11, p.z1 - 0.08, WATER, 'bnsew'); }
    else if (p.kind === 'barrel') { b.cyl(cx, y, cz, 0.3, 0.3, p.h, 9, C(0x6e5236), true); for (const hy of [0.15, p.h - 0.2]) b.cyl(cx, y + hy, cz, 0.31, 0.31, 0.06, 9, IRON, false); }
    else if (p.kind === 'crate') b.box(p.x0, y, p.z0, p.x1, y + p.h, p.z1, [C(0x9a7e5a), C(0x86694a), C(0x86694a)]);
    else if (p.kind === 'fence') {
      const ax = lx > lz, len = ax ? lx : lz, n = Math.max(1, Math.round(len / 2.4));
      for (let i = 0; i <= n; i++) { const t = i / n; b.cube(ax ? p.x0 + lx * t : cx, y + 0.6, ax ? cz : p.z0 + lz * t, 0.14, 1.3, 0.14, DARKWOOD); }
      for (const ry of [0.55, 1.05]) b.cube(cx, y + ry, cz, ax ? lx : 0.06, 0.12, ax ? 0.06 : lz, WOOD);
    } else if (p.kind === 'lamp') {
      b.cube(cx, y + 1.6, cz, 0.14, 3.2, 0.14, DARKWOOD); b.cube(cx, y + 3.25, cz, 0.36, 0.08, 0.36, IRON);
      b.cube(cx, y + 3.62, cz, 0.38, 0.08, 0.38, IRON);
      const k0 = g.count; g.box(cx - 0.15, y + 3.29, cz - 0.15, cx + 0.15, y + 3.58, cz + 0.15, [0, 0, 0], 'b'); for (let k = k0; k < g.count; k++) g.extra[k] = 2;
    } else if (p.kind === 'tower') {
      for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) b.cube(cx + dx, y + 3.3, cz + dz, 0.3, 6.8, 0.3, DARKWOOD);
      b.cube(cx, y + 6.5, cz, 3.8, 0.25, 3.8, PLANK);
      b.cyl(cx, y + 6.6, cz, 2.0, 2.0, 3.2, 12, C(0x7a6248), true); b.cyl(cx, y + 9.8, cz, 2.15, 0.2, 1.1, 12, ROOF.length ? C(0x4b4038) : WOOD, false);
      for (const hy of [7.2, 8.4, 9.4]) b.cyl(cx, y + hy, cz, 2.03, 2.03, 0.07, 12, IRON, false);
    } else if (p.kind === 'windmill') {
      for (const [dx, dz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) { b.push(new THREE.Matrix4().makeTranslation(cx + dx * 0.5, y + 4.3, cz + dz * 0.5).multiply(new THREE.Matrix4().makeRotationZ(-dx * 0.07)).multiply(new THREE.Matrix4().makeRotationX(dz * 0.07))); b.cube(0, 0, 0, 0.16, 8.8, 0.16, C(0x7a756e)); b.pop(); }
      b.cube(cx, y + 8.7, cz, 0.5, 0.5, 0.9, IRON);
      for (let k = 0; k < 14; k++) { b.push(new THREE.Matrix4().makeTranslation(cx, y + 8.7, cz - 0.5).multiply(new THREE.Matrix4().makeRotationZ(k / 14 * Math.PI * 2))); b.box(-0.18, 0.25, 0, 0.18, 1.9, 0.03, C(0xb8b2a6), ''); b.pop(); }
      b.cube(cx, y + 8.7, cz + 1.1, 0.04, 0.9, 1.4, C(0xb8b2a6));
      b.cube(cx, y + 0.5, cz - 2.6, 2.6, 1.0, 1.3, WOOD);                       // a tank below it
    } else if (p.kind === 'wagonx' || p.kind === 'wagonz') {
      b.push(new THREE.Matrix4().makeTranslation(cx, y, cz).multiply(new THREE.Matrix4().makeRotationY(p.kind === 'wagonx' ? Math.PI / 2 : 0)));
      b.box(-0.75, 0.7, -1.7, 0.75, 0.82, 1.7, PLANK); for (const s of [-1, 1]) b.box(s * 0.75 - 0.05, 0.82, -1.7, s * 0.75 + 0.05, 1.35, 1.7, WOOD, 'b');
      b.box(-0.75, 0.82, 1.65, 0.75, 1.35, 1.75, WOOD); b.box(-0.75, 0.82, -1.75, 0.75, 1.35, -1.65, WOOD);
      for (const [wz, r] of [[-1.15, 0.5], [1.2, 0.62]]) for (const s of [-1, 1]) { b.push(new THREE.Matrix4().makeTranslation(s * 0.86, r, wz).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))); b.cyl(0, -0.05, 0, r, r, 0.1, 12, C(0x5a4330), 'both'); b.pop(); }
      b.box(-0.04, 0.55, -3.3, 0.04, 0.65, -1.7, WOOD);                          // the tongue
      b.pop();
    }
  }

  // ---- the bridge: a deck on timber bents, railed both sides
  const br = field.bridge;
  if (br) {
    b.box(br.x0, br.y - 0.45, br.z0, br.x1, br.y, br.z1, [PLANK, DARKWOOD, DARKWOOD], '');
    for (let x = br.x0; x < br.x1; x += 0.9) b.box(x, br.y, br.z0 + 0.2, x + 0.04, br.y + 0.005, br.z1 - 0.2, DARKWOOD, 'bnsew');   // plank seams
    for (const z of [br.z0, br.z1 - 0.15]) {
      b.box(br.x0 + 2, br.y + 0.95, z, br.x1 - 2, br.y + 1.05, z + 0.15, WOOD); b.box(br.x0 + 2, br.y + 0.45, z + 0.03, br.x1 - 2, br.y + 0.53, z + 0.12, WOOD);
      for (let x = br.x0 + 2; x <= br.x1 - 2; x += 2.4) b.box(x - 0.08, br.y, z, x + 0.08, br.y + 1.05, z + 0.15, DARKWOOD);
    }
    for (const px of br.piers) {
      for (const pz of [br.z0 + 0.6, (br.z0 + br.z1) / 2, br.z1 - 0.6]) b.box(px - 0.2, br.water - 6, pz - 0.2, px + 0.2, br.y - 0.45, pz + 0.2, DARKWOOD);
      b.box(px - 0.3, br.y - 0.75, br.z0 - 0.3, px + 0.3, br.y - 0.45, br.z1 + 0.3, WOOD);
      for (const s of [-1, 1]) { b.push(new THREE.Matrix4().makeTranslation(px, (br.water + br.y) / 2 - 0.4, (br.z0 + br.z1) / 2).multiply(new THREE.Matrix4().makeRotationX(s * 0.62))); b.box(-0.07, -1.75, -0.07, 0.07, 1.75, 0.07, WOOD); b.pop(); }   // ends inside the deck, not through it
    }
  }

  // ---- the telegraph line
  const wires = [];
  for (const line of field.poles || []) {
    for (let i = 0; i < line.length; i++) {
      const p = line[i]; if (!p) continue;
      b.cyl(p.x, p.y - 0.3, p.z, 0.13, 0.1, 7.5, 6, C(0x5e5246), false);
      const q = line[i + 1], dir = q ? Math.atan2(q.x - p.x, q.z - p.z) : 0;
      b.push(new THREE.Matrix4().makeTranslation(p.x, p.y + 6.6, p.z).multiply(new THREE.Matrix4().makeRotationY(dir))); b.box(-0.8, -0.06, -0.06, 0.8, 0.06, 0.06, C(0x5e5246)); b.pop();
      if (q && Math.hypot(q.x - p.x, q.z - p.z) < 75) for (const s of [-0.65, 0.65]) {
        const ox = Math.cos(dir) * s, oz = -Math.sin(dir) * s, ax = p.x + ox, ay = p.y + 6.66, az = p.z + oz, bx = q.x + ox, by = q.y + 6.66, bz = q.z + oz;
        for (let k = 0; k < 6; k++) { const t0 = k / 6, t1 = (k + 1) / 6, sag = t => 4 * t * (1 - t) * 0.55; wires.push(ax + (bx - ax) * t0, ay + (by - ay) * t0 - sag(t0), az + (bz - az) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1 - sag(t1), az + (bz - az) * t1); }
      }
    }
  }

  // ---- signs: every board painted onto one canvas, in rows
  const ROW = 44, COLW = 512, perCol = Math.max(1, Math.ceil(signs.length / 2)), cv = document.createElement('canvas');
  cv.width = 2 * COLW; cv.height = Math.min(2048, 1 << Math.ceil(Math.log2(perCol * ROW)));
  const ctx = cv.getContext('2d'), rowH = Math.min(ROW, Math.floor(cv.height / perCol));
  signs.forEach((s, i) => {
    const col = i >= perCol ? 1 : 0, x0 = col * COLW, y0 = (i - col * perCol) * rowH, pw = Math.min(COLW, Math.round(rowH * s.w / s.h));
    ctx.fillStyle = i % 3 === 0 ? '#2b2420' : i % 3 === 1 ? '#3a2c22' : '#1f2a2a'; ctx.fillRect(x0, y0, pw, rowH);
    ctx.strokeStyle = 'rgba(232,214,170,0.55)'; ctx.lineWidth = 2; ctx.strokeRect(x0 + 3, y0 + 3, pw - 6, rowH - 6);
    let fs = rowH * 0.6; ctx.font = `700 ${fs}px Georgia, 'Times New Roman', serif`;
    const tw = ctx.measureText(s.text).width; if (tw > pw * 0.86) { fs *= pw * 0.86 / tw; ctx.font = `700 ${fs}px Georgia, 'Times New Roman', serif`; }
    ctx.fillStyle = i % 2 ? '#e9dcb6' : '#e8c46a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.text, x0 + pw / 2, y0 + rowH * 0.54);
    const u0 = x0 / cv.width, u1 = (x0 + pw) / cv.width, v0 = 1 - (y0 + rowH) / cv.height, v1 = 1 - y0 / cv.height;
    sg.m.copy(s.m);
    sg.quad(s.quad[0], s.quad[1], s.quad[2], s.quad[3], [1, 1, 1], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
  });
  const atlas = new THREE.CanvasTexture(cv); atlas.anisotropy = 4; atlas.encoding = THREE.sRGBEncoding;

  const glassU = { uNight: { value: 0 }, uGlass: { value: new THREE.Color(0x1d2226) } };
  const group = new THREE.Group();
  const solid = new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  const glass = new THREE.Mesh(g.geometry(), new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, glassU]), vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, fog: true }));
  const boards = new THREE.Mesh(sg.geometry(), new THREE.MeshLambertMaterial({ map: atlas }));
  const wireGeo = new THREE.BufferGeometry(); wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  const lines = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: new THREE.Color(0x2a2622) }));
  for (const m of [solid, glass, boards, lines]) { m.matrixAutoUpdate = false; group.add(m); }
  scene.add(group);
  const glassDay = new THREE.Color(0x2a3236).convertSRGBToLinear();
  return {
    group, triangles: (b.pos.length + g.pos.length + sg.pos.length) / 9, signs: signs.length,
    update(env) {
      glass.material.uniforms.uNight.value = Math.min(1, Math.max(0, 1 - env.day * 1.4));
      glass.material.uniforms.uGlass.value.copy(glassDay).multiplyScalar(0.3 + env.day * 0.9);
    },
    dispose() { scene.remove(group); for (const m of [solid, glass, boards, lines]) { m.geometry.dispose(); m.material.dispose(); } atlas.dispose(); },
  };
}
