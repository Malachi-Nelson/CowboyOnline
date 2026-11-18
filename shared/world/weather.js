// Weather. Nobody is sent it: it is worked out from the world's clock and where you stand, with the same arithmetic
// in every browser, so everyone in a world sees the same front come over the same hill. Fronts drift across the
// territory from the north-west and take several minutes to pass. The desert rarely gets rain, the high country gets
// snow instead, and the Mirewood keeps a mist of its own.
import { vnoise, ss } from './terrain.js';

const FRONT_MS = 5 * 60 * 1000;                  // how long, roughly, a front takes to pass a spot

export function weatherAt(t, x, z, terrain, seed, out = {}) {
  const k = t / FRONT_MS + (x + z) / 2400, n = vnoise(k, 0.37 + (x - z) / 5200, (seed | 0) + 41) * 0.75 + vnoise(k * 3.1, 7.1, (seed | 0) + 43) * 0.25;
  const desert = terrain.maskAt(x, z, 3), swamp = terrain.maskAt(x, z, 4), north = terrain.maskAt(x, z, 0), mount = terrain.maskAt(x, z, 1), h = terrain.heightAt(x, z);
  const wet = ss(0.56, 0.8, n + mount * 0.06) * (1 - desert * 0.85);
  const cold = Math.max(ss(0.35, 0.6, north), ss(250, 300, h));
  out.cloud = Math.min(1, ss(0.36, 0.7, n + mount * 0.08) * (1 - desert * 0.5) + cold * 0.15);
  out.rain = wet * (1 - cold);
  out.snow = wet * cold + cold * 0.25 * ss(0.3, 0.6, n);
  out.mist = Math.max(swamp * 0.75, out.rain * 0.45, out.snow * 0.5, cold * 0.2);
  return out;
}
