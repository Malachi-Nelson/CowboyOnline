// The third-person camera: behind and a little to the right of the player, looking past the shoulder. It trails the
// body by a fraction of a second rather than being bolted to it, which is a good share of why movement reads as
// having weight. At a sprint it eases back and widens slightly.
import { THREE } from '../render/three.js';

const DIST = 4.4, SHOULDER = 0.45, HEAD = 1.55, FOV = 58;

export function createCamera(field) {
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2400);
  const pivot = new THREE.Vector3(), want = new THREE.Vector3(), look = new THREE.Vector3();
  let ready = false, dist = DIST, fov = FOV, orbit = 0, tall = 0;     // tall: 0 on a wide screen, up to 1 on a phone held upright

  // play: follow the player. x, y, z is where the body is drawn; speed in m/s
  function follow(x, y, z, yaw, pitch, speed, dt) {
    const k = ready ? 1 - Math.exp(-dt / 0.07) : 1; ready = true;
    pivot.x += (x - pivot.x) * k; pivot.z += (z - pivot.z) * k; pivot.y += (y + HEAD - pivot.y) * (ready ? 1 - Math.exp(-dt / 0.12) : 1);
    const run = Math.min(1, Math.max(0, (speed - 3.6) / 2.9)), e = 1 - Math.exp(-dt / 0.35);
    dist += (DIST * (1 + tall * 0.3) + run * 0.7 - dist) * e; fov += (FOV + tall * 22 + run * 5 - fov) * e;
    const sy = Math.sin(yaw), cy = Math.cos(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // forward is (-sin yaw, -cos yaw); the camera sits behind (+forward reversed) and to the right
    let d = dist;
    const dx = sy * cp, dyv = -sp, dz = cy * cp;
    // pull in rather than look through a wall or the ground
    const hit = field.boxes.ray(pivot.x, pivot.y, pivot.z, dx, dyv, dz, dist + 0.3);
    if (hit < dist + 0.3) d = Math.max(0.6, hit - 0.3);
    want.set(pivot.x + dx * d + cy * SHOULDER, pivot.y + dyv * d + 0.15, pivot.z + dz * d - sy * SHOULDER);
    const floor = field.terrain.heightAt(want.x, want.z) + 0.35; if (want.y < floor) want.y = floor;
    cam.position.copy(want);
    look.set(pivot.x - sy * cp * 12 + cy * SHOULDER, pivot.y + sp * 12 + 0.15, pivot.z - cy * cp * 12 - sy * SHOULDER);
    cam.lookAt(look);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }
  // menu: a slow turn around a point, so the first thing on screen is the place itself
  function circle(x, y, z, dt) {
    orbit += dt * 0.05;
    const r = 34, h = 11;
    cam.position.set(x + Math.sin(orbit) * r, y + h, z + Math.cos(orbit) * r);
    const floor = field.terrain.heightAt(cam.position.x, cam.position.z) + 2; if (cam.position.y < floor) cam.position.y = floor;
    look.set(x, y + 1.2, z); cam.lookAt(look);
    pivot.set(x, y + HEAD, z); ready = false;
    return orbit;
  }
  // an upright phone sees a narrow slice of the world at the same vertical angle, so widen it and stand back
  function resize(w, h) { cam.aspect = w / h; tall = Math.min(1, Math.max(0, (1.1 - cam.aspect) / 0.6)); if (!ready) { fov = FOV + tall * 22; cam.fov = fov; } cam.updateProjectionMatrix(); }
  return { cam, follow, circle, resize };
}
