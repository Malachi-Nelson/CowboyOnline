// The solid things on the test field: the same boxes the server collides bodies with, drawn as rough timber.
import { THREE } from './three.js';
import { HUB_X, HUB_Z } from '../../../shared/constants.js';

export function createProps(scene, field) {
  const boxes = field.boxes.boxes, pos = [], nor = [], col = [];
  const tones = [0x7a5a3a, 0x6b4e31, 0x86663f, 0x5f462c];
  const c = new THREE.Color();
  const quad = (a, b, d, e, n, shade) => { for (const p of [a, b, d, a, d, e]) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); col.push(c.r * shade, c.g * shade, c.b * shade); } };
  boxes.forEach((b, i) => {
    c.setHex(tones[i % tones.length]).convertSRGBToLinear();
    const x0 = b.x0 - HUB_X, x1 = b.x1 - HUB_X, z0 = b.z0 - HUB_Z, z1 = b.z1 - HUB_Z, y0 = b.y0 - 0.5, y1 = b.y1;
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], 1.12);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0.95);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], 0.9);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 1);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0.86);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.position.set(HUB_X, 0, HUB_Z); scene.add(mesh);
  return mesh;
}
