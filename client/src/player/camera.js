// The third-person camera: behind and a little to the right of the player, looking past the shoulder. It trails the
// body by a fraction of a second rather than being bolted to it, which is a good share of why movement reads as
// having weight. At a run it eases back and widens a little; in the saddle it sits higher and further back, and at a
// gallop further still, so the speed shows in the edges of the picture.
//
// Aiming brings it in over the shoulder, narrows the view, and stops it trailing: the middle of the screen is then
// the line a shot leaves on (AIM in shared/sim/guns.js gives the same head height and shoulder offset), so what is
// under the sights is what the bullet goes at.
import { THREE } from '../render/three.js';
import { AIM } from '../../../shared/sim/guns.js';

const DIST = 4.4, SHOULDER = 0.45, HEAD = AIM.head, FOV = 58;
const RIDE_DIST = 6.2, RIDE_HEAD = AIM.rideHead, RIDE_SHOULDER = 0.6;
const AIM_DIST = 2.5, AIM_RIDE_DIST = 3.7, AIM_FOV = 44;

export function createCamera(field) {
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.3, 3200);
  const pivot = new THREE.Vector3(), want = new THREE.Vector3(), look = new THREE.Vector3();
  let ready = false, dist = DIST, fov = FOV, orbit = 0, tall = 0, ride = 0, aimK = 0, kick = 0, narrow = 0;   // tall: 0 on a wide screen, up to 1 on a phone held upright

  // play: follow the player. x, y, z is where the body (or the horse) is drawn; speed in m/s; riding 0 or 1; aiming
  // 0 or 1; focus 0 or 1 (Iron Nerve: a narrower view still)
  function follow(x, y, z, yaw, pitch, speed, dt, riding = 0, aiming = 0, focus = 0) {
    aimK += (aiming - aimK) * (ready ? 1 - Math.exp(-dt / 0.09) : 1);
    narrow += (focus - narrow) * (ready ? 1 - Math.exp(-dt / 0.25) : 1);
    const lag = 1 - aimK, k = ready ? 1 - Math.exp(-dt / (0.07 * lag + 0.001)) : 1;
    ride += (riding - ride) * (ready ? 1 - Math.exp(-dt / 0.35) : 1);
    const head = HEAD + (RIDE_HEAD - HEAD) * ride, shoulder = SHOULDER + (RIDE_SHOULDER - SHOULDER) * ride + ((AIM.shoulder + (AIM.rideShoulder - AIM.shoulder) * ride) - (SHOULDER + (RIDE_SHOULDER - SHOULDER) * ride)) * aimK;
    pivot.x += (x - pivot.x) * k; pivot.z += (z - pivot.z) * k; pivot.y += (y + head - pivot.y) * (ready ? 1 - Math.exp(-dt / (0.12 * lag + 0.001)) : 1);
    ready = true;
    // how fast, as a share of a sprint on foot or of a gallop in the saddle
    const run = (ride > 0.5 ? Math.min(1, Math.max(0, (speed - 4) / 13)) : Math.min(1, Math.max(0, (speed - 3.6) / 2.9))) * lag, e = 1 - Math.exp(-dt / (0.45 * lag + 0.08));
    const base = (DIST + (RIDE_DIST - DIST) * ride) * lag + (AIM_DIST + (AIM_RIDE_DIST - AIM_DIST) * ride) * aimK;
    dist += (base * (1 + tall * 0.3) + run * (0.7 + ride * 1.6) - dist) * e;
    fov += ((FOV + tall * 22 + run * (5 + ride * 7)) * lag + (AIM_FOV + tall * 14 - narrow * 6) * aimK - fov) * e;
    kick *= Math.exp(-dt / 0.09); pitch += kick;
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
  // a shot's kick: the view jumps up a little and settles (the aim itself is not moved)
  const recoil = a => { kick += a; };
  return { cam, follow, circle, resize, recoil, get riding() { return ride; }, get aiming() { return aimK; } };
}
