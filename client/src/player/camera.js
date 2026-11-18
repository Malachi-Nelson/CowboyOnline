// The third-person camera: behind and a little to the right of the player, looking past the shoulder. It trails the
// body by a fraction of a second rather than being bolted to it, which is a good share of why movement reads as
// having weight. At a run it eases back and widens a little; in the saddle it sits higher and further back, and at a
// gallop further still, so the speed shows in the edges of the picture.
import { THREE } from '../render/three.js';

const DIST = 4.4, SHOULDER = 0.45, HEAD = 1.55, FOV = 58;
const RIDE_DIST = 6.2, RIDE_HEAD = 2.45, RIDE_SHOULDER = 0.6;

export function createCamera(field) {
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.3, 3200);
  const pivot = new THREE.Vector3(), want = new THREE.Vector3(), look = new THREE.Vector3();
  let ready = false, dist = DIST, fov = FOV, orbit = 0, tall = 0, ride = 0;   // tall: 0 on a wide screen, up to 1 on a phone held upright

  // play: follow the player. x, y, z is where the body (or the horse) is drawn; speed in m/s; riding 0 or 1
  function follow(x, y, z, yaw, pitch, speed, dt, riding = 0) {
    const k = ready ? 1 - Math.exp(-dt / 0.07) : 1;
    ride += (riding - ride) * (ready ? 1 - Math.exp(-dt / 0.35) : 1);
    const head = HEAD + (RIDE_HEAD - HEAD) * ride, shoulder = SHOULDER + (RIDE_SHOULDER - SHOULDER) * ride;
    pivot.x += (x - pivot.x) * k; pivot.z += (z - pivot.z) * k; pivot.y += (y + head - pivot.y) * (ready ? 1 - Math.exp(-dt / 0.12) : 1);
    ready = true;
    // how fast, as a share of a sprint on foot or of a gallop in the saddle
    const run = ride > 0.5 ? Math.min(1, Math.max(0, (speed - 4) / 9)) : Math.min(1, Math.max(0, (speed - 3.6) / 2.9)), e = 1 - Math.exp(-dt / 0.45);
    const base = DIST + (RIDE_DIST - DIST) * ride;
    dist += (base * (1 + tall * 0.3) + run * (0.7 + ride * 1.6) - dist) * e; fov += (FOV + tall * 22 + run * (5 + ride * 5) - fov) * e;
    const sy = Math.sin(yaw), cy = Math.cos(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // forward is (-sin yaw, -cos yaw); the camera sits behind and to the right
    let d = dist;
    const dx = sy * cp, dyv = -sp, dz = cy * cp;
    // pull in rather than look through a wall or the ground
    const hit = field.boxes.ray(pivot.x, pivot.y, pivot.z, dx, dyv, dz, dist + 0.3);
    if (hit < dist + 0.3) d = Math.max(0.6, hit - 0.3);
    want.set(pivot.x + dx * d + cy * shoulder, pivot.y + dyv * d + 0.15, pivot.z + dz * d - sy * shoulder);
    // and keep the line from the camera to the player above the ground, so a hill behind does not swallow the view
    const t = field.terrain;
    for (let i = 1; i <= 4; i++) {
      const f = i / 4, px = pivot.x + (want.x - pivot.x) * f, pz = pivot.z + (want.z - pivot.z) * f, py = pivot.y + (want.y - pivot.y) * f, g = t.heightAt(px, pz) + 0.4;
      if (py < g) want.y += (g - py) / f;
    }
    cam.position.copy(want);
    look.set(pivot.x - sy * cp * 12 + cy * shoulder, pivot.y + sp * 12 + 0.15, pivot.z - cy * cp * 12 - sy * shoulder);
    cam.lookAt(look);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }
  // menu: a slow turn around a point, so the first thing on screen is the place itself
  function circle(x, y, z, dt, r = 46, h = 14) {
    orbit += dt * 0.04;
    cam.position.set(x + Math.sin(orbit) * r, y + h, z + Math.cos(orbit) * r);
    const floor = field.terrain.heightAt(cam.position.x, cam.position.z) + 2; if (cam.position.y < floor) cam.position.y = floor;
    look.set(x, y + 3, z); cam.lookAt(look);
    pivot.set(x, y + HEAD, z); ready = false;
    return orbit;
  }
  // an upright phone sees a narrow slice of the world at the same vertical angle, so widen it and stand back
  function resize(w, h) { cam.aspect = w / h; tall = Math.min(1, Math.max(0, (1.1 - cam.aspect) / 0.6)); if (!ready) { fov = FOV + tall * 22; cam.fov = fov; } cam.updateProjectionMatrix(); }
  return { cam, follow, circle, resize, get riding() { return ride; } };
}
