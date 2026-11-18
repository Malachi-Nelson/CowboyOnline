// The playing field: the ground, the water, everything solid on it, and where the places are. Both sides build it
// from the same seed, once, and keep it.
import { makeTerrain, NO_WATER } from './terrain.js';
import { makeTrees, NO_TREES } from './trees.js';
import { buildTowns } from './towns.js';
import { BoxWorld } from './collide.js';
import { WORLD_SEED, HUB_X, HUB_Z } from '../constants.js';

const STEP = 0.45;                               // how high a body steps up without jumping
const fields = new Map();

export function makeField(seed = WORLD_SEED) {
  let f = fields.get(seed);
  if (f) return f;
  const terrain = makeTerrain(seed), boxes = new BoxWorld(), trees = makeTrees(terrain, seed), towns = buildTowns(terrain, boxes, seed);
  f = {
    seed, terrain, boxes, trees, base: terrain.hubLevel, places: terrain.places, ...towns,
    // the highest thing under (x, z) that feet at `feet` could be standing on
    groundAt(x, z, feet, step = STEP) {
      const t = terrain.heightAt(x, z), b = boxes.topUnder(x, z, feet, step);
      return b > t ? b : t;
    },
  };
  fields.set(seed, f);
  return f;
}

// Level ground with a few things to run into, climb and weave through: for testing how movement feels with the
// territory out of the way.
export function flatField(base = 20) {
  const boxes = new BoxWorld(), terrain = { hubLevel: base, heightAt: () => base, levelAt: () => NO_WATER };
  const B = (x0, x1, y0, y1, z0, z1) => boxes.solid(HUB_X + x0, HUB_X + x1, base + y0, base + y1, HUB_Z + z0, HUB_Z + z1);
  B(-26, -12, 0, 3, -24, -23.5); B(-26, -25.5, 0, 3, -23.5, -16);                 // an L-shaped wall
  for (let i = 0; i < 3; i++) B(16 + i * 0.9, 16.9 + i * 0.9, 0, 0.4 * (i + 1), -4, 2);   // three steps up to a deck
  B(18.7, 28, 0, 1.2, -6, 4);
  for (let i = 0; i < 5; i++) B(-4 + i * 4, -3.3 + i * 4, 0, 2.6, 22, 22.7);      // a row of posts
  B(-30, -18, 0, 1.4, 14, 14.3); B(-30, -18, 0, 1.4, 25.7, 26); B(-30.3, -30, 0, 1.4, 14, 26);   // a pen with one open side
  B(6, 7.2, 0, 1.2, -20, -18.8); B(7.2, 8.4, 0, 0.45, -20, -18.8); B(9.5, 11, 0, 1.5, -22, -20.5);   // crates
  return {
    seed: 0, terrain, boxes, trees: NO_TREES, base, places: [], buildings: [], props: [], streets: [], bridge: null,
    groundAt(x, z, feet, step = STEP) { const b = boxes.topUnder(x, z, feet, step); return b > base ? b : base; },
  };
}
