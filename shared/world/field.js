// The Phase 2 test field: rolling ground from a seed, with a flat table at the hub and a few solid things on it to
// run into, climb and weave through. Both sides build it from the same seed. Phase 3 replaces this with the baked world.
import { makeTerrain } from './terrain.js';
import { BoxWorld } from './collide.js';
import { HUB_X, HUB_Z } from '../constants.js';
import { FOOT } from '../sim/moveFoot.js';

export function makeField(seed = 1899) {
  const terrain = makeTerrain(seed), boxes = new BoxWorld(), base = terrain.heightAt(HUB_X, HUB_Z);
  const B = (x0, x1, y0, y1, z0, z1) => boxes.solid(HUB_X + x0, HUB_X + x1, base + y0, base + y1, HUB_Z + z0, HUB_Z + z1);
  // an L-shaped wall to run along and round
  B(-26, -12, 0, 3, -24, -23.5);
  B(-26, -25.5, 0, 3, -23.5, -16);
  // three steps up to a deck
  for (let i = 0; i < 3; i++) B(16 + i * 0.9, 16.9 + i * 0.9, 0, 0.4 * (i + 1), -4, 2);
  B(18.7, 28, 0, 1.2, -6, 4);
  // a row of posts to weave through
  for (let i = 0; i < 5; i++) B(-4 + i * 4, -3.3 + i * 4, 0, 2.6, 22, 22.7);
  // a pen with one open side
  B(-30, -18, 0, 1.4, 14, 14.3);
  B(-30, -18, 0, 1.4, 25.7, 26);
  B(-30.3, -30, 0, 1.4, 14, 26);
  // crates: one to step onto, two to go round
  B(6, 7.2, 0, 1.2, -20, -18.8);
  B(7.2, 8.4, 0, 0.45, -20, -18.8);
  B(9.5, 11, 0, 1.5, -22, -20.5);
  return {
    seed, terrain, boxes, base,
    groundAt(x, z, feet) {
      const t = terrain.heightAt(x, z), b = boxes.topUnder(x, z, feet, FOOT.step);
      return b > t ? b : t;
    },
  };
}
