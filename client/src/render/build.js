// A small mesh builder: boxes, prisms, cylinders and quads pushed into one geometry with flat normals and vertex
// colours, under a current transform. Towns, trees and figures are all made of these, so a whole street is one
// draw call.
import { THREE } from './three.js';

const cache = new Map();
// an sRGB hex colour as linear [r, g, b], which is what vertex colours want with sRGB output
export function C(hex, k = 1) {
  const key = hex * 8 + k;
  let v = cache.get(key);
  if (!v) { const c = new THREE.Color(hex).convertSRGBToLinear(); v = [c.r * k, c.g * k, c.b * k]; cache.set(key, v); }
  return v;
}
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3(), E = new THREE.Vector3(), N = new THREE.Vector3();

export class Builder {
  constructor(withUv = false) { this.pos = []; this.nor = []; this.col = []; this.uv = withUv ? [] : null; this.extra = null; this.m = new THREE.Matrix4(); this.stack = []; }
  // transforms: everything pushed after this goes through m (applied on top of the current one)
  push(m) { this.stack.push(this.m.clone()); if (m) this.m.multiply(m); return this; }
  pop() { this.m.copy(this.stack.pop()); return this; }
  at(x, y, z, ry = 0, rx = 0, rz = 0) { const m = new THREE.Matrix4().makeTranslation(x, y, z); if (ry) m.multiply(new THREE.Matrix4().makeRotationY(ry)); if (rx) m.multiply(new THREE.Matrix4().makeRotationX(rx)); if (rz) m.multiply(new THREE.Matrix4().makeRotationZ(rz)); return this.push(m); }
  get count() { return this.pos.length / 3; }

  // one triangle; c is [r, g, b] or a function of the (local) point. uvs: three [u, v] pairs, when building with uvs.
  tri(a, b, d, c, uvs, ex) {
    A.set(a[0], a[1], a[2]).applyMatrix4(this.m); B.set(b[0], b[1], b[2]).applyMatrix4(this.m); D.set(d[0], d[1], d[2]).applyMatrix4(this.m);
    N.subVectors(D, B).cross(E.subVectors(A, B)).normalize();
    const P = this.pos, Q = this.nor, K = this.col;
    for (const [v, l] of [[A, a], [B, b], [D, d]]) {
      P.push(v.x, v.y, v.z); Q.push(N.x, N.y, N.z);
      const k = typeof c === 'function' ? c(l[0], l[1], l[2]) : c; K.push(k[0], k[1], k[2]);
    }
    if (this.uv) { if (uvs) this.uv.push(uvs[0][0], uvs[0][1], uvs[1][0], uvs[1][1], uvs[2][0], uvs[2][1]); else this.uv.push(0, 0, 0, 0, 0, 0); }
    if (this.extra) for (let i = 0; i < 3; i++) this.extra.push(ex === undefined ? 0 : ex);
  }
  // four corners in order round the face, seen from the front (anticlockwise)
  quad(a, b, d, e, c, uv, ex) {
    if (uv) { this.tri(a, b, d, c, [uv[0], uv[1], uv[2]], ex); this.tri(a, d, e, c, [uv[0], uv[2], uv[3]], ex); }
    else { this.tri(a, b, d, c, null, ex); this.tri(a, d, e, c, null, ex); }
  }
  // an axis-aligned box; c may be one colour or [top, sides, bottom]. skip: faces to leave out, e.g. 'b' for the bottom
  box(x0, y0, z0, x1, y1, z1, c, skip = 'b') {
    const top = c.length === 3 && Array.isArray(c[0]) ? c[0] : c, side = c.length === 3 && Array.isArray(c[0]) ? c[1] : c, bot = c.length === 3 && Array.isArray(c[0]) ? c[2] : c;
    if (!skip.includes('t')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top);
    if (!skip.includes('b')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], bot);
    if (!skip.includes('s')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side);   // +z
    if (!skip.includes('n')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], side);   // -z
    if (!skip.includes('e')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side);   // +x
    if (!skip.includes('w')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side);   // -x
  }
  // a box given by its centre and size
  cube(x, y, z, w, h, d, c, skip) { this.box(x - w / 2, y - h / 2, z - d / 2, x + w / 2, y + h / 2, z + d / 2, c, skip); }
  // a tapering cylinder (or a cone with r1 = 0) standing on (x, y, z)
  cyl(x, y, z, r0, r1, h, seg, c, caps = true) {
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2, s0 = Math.sin(a0), c0 = Math.cos(a0), s1 = Math.sin(a1), c1 = Math.cos(a1);
      const p0 = [x + s0 * r0, y, z + c0 * r0], p1 = [x + s1 * r0, y, z + c1 * r0], q0 = [x + s0 * r1, y + h, z + c0 * r1], q1 = [x + s1 * r1, y + h, z + c1 * r1];
      if (r1 > 0) this.quad(p0, p1, q1, q0, c); else this.tri(p0, p1, [x, y + h, z], c);
      if (caps && r1 > 0) this.tri([x, y + h, z], q0, q1, c);
      if (caps === 'both') this.tri([x, y, z], p1, p0, c);
    }
  }
  // a roof: a triangular prism along x from x0 to x1, eaves at y0 either side of z0..z1, ridge at y1 over the middle
  gable(x0, x1, z0, z1, y0, y1, c, ends) {
    const zm = (z0 + z1) / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, zm], [x0, y1, zm], c);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, zm], [x1, y1, zm], c);
    if (ends) { this.tri([x1, y0, z1], [x1, y0, z0], [x1, y1, zm], ends); this.tri([x0, y0, z0], [x0, y0, z1], [x0, y1, zm], ends); }
  }
  // the same with the ridge along z, from x0..x1 (eaves) over z0..z1
  gableZ(x0, x1, z0, z1, y0, y1, c) {
    const xm = (x0 + x1) / 2;
    this.quad([x0, y0, z0], [x0, y0, z1], [xm, y1, z1], [xm, y1, z0], c);
    this.quad([x1, y0, z1], [x1, y0, z0], [xm, y1, z0], [xm, y1, z1], c);
  }
  // the triangular wall under such a roof: at zBack facing -z, at zFront facing +z (either may be null)
  gableEndsZ(x0, x1, y0, y1, zBack, zFront, c) {
    const xm = (x0 + x1) / 2;
    if (zFront !== null) this.tri([x0, y0, zFront], [x1, y0, zFront], [xm, y1, zFront], c);
    if (zBack !== null) this.tri([x1, y0, zBack], [x0, y0, zBack], [xm, y1, zBack], c);
  }
  // a low-poly blob (an octahedron with its corners pulled about by `jag`), for leafy crowns and bushes
  blob(x, y, z, rx, ry, rz, c, seed = 1, jag = 0.25) {
    let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const t = 0.5257, u = 0.8507;
    const V = [[-t, u, 0], [t, u, 0], [-t, -u, 0], [t, -u, 0], [0, -t, u], [0, t, u], [0, -t, -u], [0, t, -u], [u, 0, -t], [u, 0, t], [-u, 0, -t], [-u, 0, t]].map(v => { const k = 1 + (r() - 0.5) * 2 * jag; return [x + v[0] * rx * k, y + v[1] * ry * k, z + v[2] * rz * k]; });
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (const f of F) this.tri(V[f[0]], V[f[1]], V[f[2]], c);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.extra) g.setAttribute('lit', new THREE.Float32BufferAttribute(this.extra, 1));
    g.computeBoundingSphere();
    return g;
  }
}
