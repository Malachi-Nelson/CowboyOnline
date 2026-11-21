// Everything built by hand in the territory: Calder's Landing and the smaller places, the bridge, fences and
// street furniture. Each thing is described once here. The server takes the solid boxes from it; the browser draws
// roofs, porches and signs from the same descriptions, so what stops a body is what is on screen.
//
// Solids are axis-aligned boxes (see collide.js), so every street runs east-west or north-south.
import { HUB_Z } from '../constants.js';
import { rng32 } from '../math.js';

// [sign, width, depth, storeys, wall tone, kind]
const MAIN_NORTH = [['LIVERY', 18, 15, 1.6, 2, 'barn'], ['SMITHY', 10, 9, 1, 5], ['CARPENTER', 10, 9, 1, 1], ['UNDERTAKER', 9, 9, 1, 6], ['STAGE OFFICE', 12, 10, 1, 3], null,
  ['GENERAL STORE', 14, 12, 1, 0], ['BRASS SPUR SALOON', 16, 14, 2, 4], ['LANDING HOTEL', 15, 13, 2, 7], ['BANK', 11, 10, 1, 8], ['TELEGRAPH', 8, 8, 1, 1], ['ASSAY', 9, 9, 1, 3], ['BATHS', 8, 8, 1, 0]];
const MAIN_SOUTH = [['SHERIFF', 11, 10, 1, 3], ['GUNSMITH', 9, 9, 1, 5], ['DOCTOR', 9, 9, 1, 0], ['BARBER', 8, 8, 1, 7], ['NEWSPAPER', 10, 9, 1, 1], ['SADDLER', 10, 9, 1, 2], null,
  ['LAND OFFICE', 10, 9, 1, 6], ['DRY GOODS', 13, 11, 2, 0], ['BOARDING HOUSE', 14, 12, 2, 4], ['FEED & GRAIN', 12, 11, 1.4, 2, 'barn'], ['BAKERY', 9, 9, 1, 7], ['TAILOR', 9, 8, 1, 1]];

export function buildTowns(terrain, boxes, seed) {
  const buildings = [], props = [], streets = [], rand = rng32((seed ^ 0x7ac0b1) >>> 0);
  const place = id => terrain.places.find(p => p.id === id);

  // One building. `face` is the side its front is on (n, s, e, w); a0 is where it starts along the street,
  // `front` the line its front wall stands on, w its width along the street and d its depth back from it.
  function building(y, face, a0, w, front, d, o = {}) {
    const st = o.storeys || 1, h = o.h || (3.6 * st + 0.5);
    let x0, x1, z0, z1;
    if (face === 's') { x0 = a0; x1 = a0 + w; z1 = front; z0 = front - d; }
    else if (face === 'n') { x0 = a0; x1 = a0 + w; z0 = front; z1 = front + d; }
    else if (face === 'e') { z0 = a0; z1 = a0 + w; x1 = front; x0 = front - d; }
    else { z0 = a0; z1 = a0 + w; x0 = front; x1 = front + d; }
    const b = { x0, x1, z0, z1, y, h, face, storeys: st, sign: o.sign || '', tone: o.tone || 0, kind: o.kind || 'shop', roof: o.roof || (o.kind === 'adobe' ? 'flat' : 'gable'),
      front: o.front === undefined ? (o.kind === 'shop' || !o.kind ? 1.3 + rand() * 0.9 : 0) : o.front, porch: o.porch === undefined ? 2.4 : o.porch, seed: (rand() * 65536) | 0 };
    boxes.solid(x0, x1, y - 4, y + h, z0, z1);
    if (b.porch > 0) {                                                            // a boardwalk under an awning, on posts
      const pd = b.porch, s = face === 's' || face === 'e' ? 1 : -1, along = face === 's' || face === 'n';
      const f0 = s > 0 ? front : front - pd, f1 = s > 0 ? front + pd : front, edge = s > 0 ? f1 - 0.16 : f0;
      if (along) boxes.solid(x0, x1, y - 2, y + 0.3, f0, f1); else boxes.solid(f0, f1, y - 2, y + 0.3, z0, z1);
      const n = Math.max(2, Math.round(w / 3.4) + 1);
      for (let i = 0; i < n; i++) {
        const a = a0 + 0.1 + (w - 0.36) * i / (n - 1);
        if (along) boxes.solid(a, a + 0.16, y, y + 2.9, edge, edge + 0.16); else boxes.solid(edge, edge + 0.16, y, y + 2.9, a, a + 0.16);
      }
    }
    buildings.push(b);
    return b;
  }
  // street furniture: solid, and drawn from the same record
  function prop(kind, x0, x1, y, h, z0, z1) { boxes.solid(x0, x1, y - 1, y + h, z0, z1); props.push({ kind, x0, x1, z0, z1, y, h }); }
  function fence(x0, z0, x1, z1, y) {
    if (x0 === x1) prop('fence', x0 - 0.07, x0 + 0.07, y, 1.25, Math.min(z0, z1), Math.max(z0, z1));
    else prop('fence', Math.min(x0, x1), Math.max(x0, x1), y, 1.25, z0 - 0.07, z0 + 0.07);
  }
  // a row of shop fronts along an east-west street
  function row(defs, y, face, from, front, clutter) {
    let a = from;
    for (const d of defs) {
      if (!d) { a = 1996; continue; }                                            // the cross street
      const [sign, w, dep, st, tone, kind] = d, s = face === 's' ? 1 : -1;            // s: which way the street is from the front
      building(y, face, a, w, front, dep, { sign, storeys: st, tone, kind: kind || 'shop' });
      if (clutter) {
        const zf = front + s * 3.9, k = rand();
        if (k < 0.6) prop('rail', a + w * 0.5 - 1.6, a + w * 0.5 + 1.6, y, 1.05, zf - 0.06, zf + 0.06);            // a hitching rail
        else if (k < 0.8) prop('trough', a + w * 0.5 - 1, a + w * 0.5 + 1, y, 0.55, zf - 0.3, zf + 0.3);
        if (rand() < 0.5) { const bx = a + w - 1.1, bz = front + s * 1.4; prop('barrel', bx - 0.32, bx + 0.32, y + 0.3, 0.9, bz - 0.32, bz + 0.32); }
        if (rand() < 0.35) { const bx = a + 0.9, bz = front + s * 1.3; prop('crate', bx - 0.4, bx + 0.4, y + 0.3, 0.8, bz - 0.4, bz + 0.4); }
      }
      a += w + 2.5 + rand() * 1.5;
    }
  }

  // ---- Calder's Landing: a main street running down to the bridge, and a cross street of houses
  const hub = place('hub'), y = hub.y, zs = HUB_Z;
  row(MAIN_NORTH, y, 's', 1896, zs - 10.5, true);
  row(MAIN_SOUTH, y, 'n', 1898, zs + 10.5, true);
  for (const [face, front] of [['e', 1976.5], ['w', 1993.5]]) for (const [from, to] of [[1975, 2022], [2074, 2128]]) {
    let a = from; while (a + 8 <= to) { const w = 8 + rand() * 2.5; building(y, face, a, w, front, 7.5 + rand() * 2, { kind: 'house', tone: (rand() * 9) | 0, front: 0, porch: rand() < 0.7 ? 2 : 0 }); a += w + 3 + rand() * 3; }
  }
  building(y, 's', 1980.5, 9, 1962, 17, { kind: 'church', tone: 8, front: 0, porch: 0, h: 6.2, sign: '' });
  building(y, 's', 2204, 16, zs - 12, 12, { kind: 'barn', tone: 2, sign: 'FREIGHT', storeys: 1.5 });
  building(y, 'n', 2206, 11, zs + 12, 9, { sign: 'FERRY HOUSE', tone: 5 });
  streets.push({ place: 'hub', x0: 1892, x1: 2102, z0: zs - 6.5, z1: zs + 6.5 }, { place: 'hub', x0: 1979.5, x1: 1990.5, z0: 1968, z1: 2134 }, { place: 'hub', x0: 2194, x1: 2236, z0: zs - 7, z1: zs + 7 });

  // the bridge: a deck to walk and ride on, rails so nobody goes over the side, piers down into the bed
  const r = terrain.river, bx = r.x[r.iHub], bw = r.hw[r.iHub], bridge = { x0: bx - bw - 15, x1: bx + bw + 15, z0: zs - 3.3, z1: zs + 3.3, y: y + 0.25, water: r.wl[r.iHub], piers: [] };
  boxes.solid(bridge.x0, bridge.x1, bridge.y - 0.45, bridge.y, bridge.z0, bridge.z1);
  boxes.solid(bridge.x0 + 2, bridge.x1 - 2, bridge.y, bridge.y + 1.05, bridge.z0, bridge.z0 + 0.15);
  boxes.solid(bridge.x0 + 2, bridge.x1 - 2, bridge.y, bridge.y + 1.05, bridge.z1 - 0.15, bridge.z1);
  for (let i = 0; i < 4; i++) { const px = bridge.x0 + 9 + (bridge.x1 - bridge.x0 - 18) * i / 3; boxes.solid(px - 0.45, px + 0.45, bridge.water - 6, bridge.y - 0.45, zs - 2.8, zs + 2.8); bridge.piers.push(px); }

  // ---- the smaller places: [dx, dz of the front-left corner along the street, width, depth, face, options]
  function hamlet(id, list, street) {
    const p = place(id);
    for (const [dx, dz, w, d, face, o] of list) building(p.y, face, face === 's' || face === 'n' ? p.x + dx : p.z + dz, w, face === 's' || face === 'n' ? p.z + dz : p.x + dx, d, o);
    streets.push({ place: id, x0: p.x + street[0], x1: p.x + street[1], z0: p.z + street[2], z1: p.z + street[3] });
    return p;
  }
  hamlet('timber', [
    [-44, -9, 22, 16, 's', { kind: 'barn', sign: 'SAWMILL', tone: 2, storeys: 1.6 }], [-16, -9, 13, 9, 's', { kind: 'house', tone: 1, front: 0, sign: 'BUNKHOUSE' }], [2, -9, 10, 9, 's', { kind: 'house', tone: 3, front: 0 }],
    [-34, 9, 12, 10, 'n', { sign: 'COMPANY STORE', tone: 0 }], [-16, 9, 8, 8, 'n', { kind: 'house', tone: 5, front: 0 }], [-3, 9, 8, 8, 'n', { kind: 'house', tone: 1, front: 0, porch: 0 }], [10, 9, 9, 8, 'n', { kind: 'house', tone: 3, front: 0 }],
  ], [-46, 24, -6, 6]);
  hamlet('lantern', [
    [-16, -7, 8, 7, 's', { kind: 'house', tone: 1, front: 0, porch: 1.6 }], [3, -8, 9, 7, 's', { kind: 'house', tone: 5, front: 0, porch: 1.6, sign: 'FURS' }], [-7, 9, 9, 7, 'n', { kind: 'house', tone: 2, front: 0, porch: 0 }],
    [16, 7, 4, 4, 'n', { kind: 'tent', tone: 9, front: 0, porch: 0, h: 2.2 }], [-22, 8, 4, 4, 'n', { kind: 'tent', tone: 9, front: 0, porch: 0, h: 2.2 }],
  ], [-22, 20, -5, 6]);
  hamlet('mirewood', [
    [-26, -8, 7, 6, 's', { kind: 'house', tone: 6, front: 0, porch: 1.8 }], [-13, -8, 11, 8, 's', { sign: 'BAIT & TACKLE', tone: 5 }], [4, -9, 7, 6, 's', { kind: 'house', tone: 2, front: 0, porch: 1.8 }], [17, -8, 7, 7, 's', { kind: 'house', tone: 6, front: 0, porch: 0 }],
    [-20, 8, 8, 7, 'n', { kind: 'house', tone: 5, front: 0, porch: 1.8 }], [-5, 8, 7, 6, 'n', { kind: 'house', tone: 2, front: 0 }], [9, 9, 9, 7, 'n', { kind: 'house', tone: 6, front: 0, porch: 1.8 }],
  ], [-28, 26, -5, 5]);
  hamlet('dryfork', [
    [-44, -10, 14, 12, 's', { kind: 'adobe', sign: 'STABLE', tone: 10, front: 0.8 }], [-26, -10, 13, 11, 's', { kind: 'adobe', sign: 'CANTINA', tone: 11, front: 0.8 }], [-9, -10, 12, 10, 's', { kind: 'adobe', sign: 'TRADING POST', tone: 10, front: 0.8 }], [7, -10, 9, 9, 's', { kind: 'adobe', tone: 11, front: 0.6 }], [20, -10, 10, 9, 's', { kind: 'adobe', tone: 10, front: 0.6, sign: 'WELL & WATER' }],
    [-40, 10, 9, 9, 'n', { kind: 'adobe', sign: 'JAIL', tone: 11, front: 0.8 }], [-27, 10, 13, 11, 'n', { kind: 'adobe', sign: 'HOTEL', tone: 10, storeys: 2, front: 0.8 }], [-10, 10, 8, 8, 'n', { kind: 'adobe', tone: 11, front: 0.6 }], [2, 10, 9, 8, 'n', { kind: 'adobe', tone: 10, front: 0.6 }], [15, 10, 11, 9, 'n', { kind: 'adobe', sign: 'ASSAY', tone: 11, front: 0.8 }],
  ], [-46, 32, -6, 6]);
  const ranch = hamlet('ranch', [
    [-18, -12, 13, 10, 's', { kind: 'house', tone: 8, front: 0, storeys: 2, porch: 2.6 }], [4, -14, 16, 20, 's', { kind: 'barn', tone: 4, storeys: 1.8, sign: 'TOLLIVER' }], [-36, -10, 11, 8, 's', { kind: 'house', tone: 1, front: 0, sign: 'BUNKHOUSE' }],
  ], [-38, 24, -8, 6]);
  // the ranch corral, with a gap for a gate on its north side
  { const x0 = ranch.x - 22, x1 = ranch.x + 14, z0 = ranch.z + 12, z1 = ranch.z + 40, yy = ranch.y; fence(x0, z0, x0 + 13, z0, yy); fence(x0 + 18, z0, x1, z0, yy); fence(x0, z1, x1, z1, yy); fence(x0, z0, x0, z1, yy); fence(x1, z0, x1, z1, yy); }

  // ---- the lock-up behind the sheriff's office: an iron cage with a plank roof, closed on every side. Whoever the law
  // takes in is put inside, and let out at the office door when their time is done.
  let jail = null;
  {
    const sh = buildings.find(b => b.sign === 'SHERIFF'), x0 = sh.x0 + 1.5, x1 = x0 + 3.6, z0 = sh.z1 + 1.2, z1 = z0 + 3.6, t = 0.1, H = 2.6;
    boxes.solid(x0, x1, y - 1, y + H, z0, z0 + t); boxes.solid(x0, x1, y - 1, y + H, z1 - t, z1);
    boxes.solid(x0, x0 + t, y - 1, y + H, z0, z1); boxes.solid(x1 - t, x1, y - 1, y + H, z0, z1);
    boxes.solid(x0 - 0.25, x1 + 0.25, y + H, y + H + 0.18, z0 - 0.25, z1 + 0.25);
    props.push({ kind: 'cell', x0, x1, z0, z1, y, h: H });
    jail = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, y, door: { x: (sh.x0 + sh.x1) / 2, z: sh.z0 - 4.5 }, office: { x0: sh.x0, x1: sh.x1, z0: sh.z0, z1: sh.z1 } };
  }

  // ---- the things that make a place look used: lamps along the main street, a water tower, a windmill, wagons
  for (let x = 1902; x < 2096; x += 24) for (const side of [-1, 1]) {
    if (x > 1974 && x < 1996) continue;                                         // the mouth of the cross street
    const lz = zs + side * 6.9; prop('lamp', x - 0.1, x + 0.1, y, 3.4, lz - 0.1, lz + 0.1);
  }
  { const tx = 2234, tz = zs - 21; for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) boxes.solid(tx + dx - 0.15, tx + dx + 0.15, y - 1, y + 6.2, tz + dz - 0.15, tz + dz + 0.15); props.push({ kind: 'tower', x0: tx - 2, x1: tx + 2, z0: tz - 2, z1: tz + 2, y, h: 10 }); }
  { const wx = ranch.x + 27, wz = ranch.z - 2, wy = terrain.heightAt(wx, wz); for (const [dx, dz] of [[-1.1, -1.1], [1.1, -1.1], [-1.1, 1.1], [1.1, 1.1]]) boxes.solid(wx + dx - 0.12, wx + dx + 0.12, wy - 1, wy + 8, wz + dz - 0.12, wz + dz + 0.12); props.push({ kind: 'windmill', x0: wx - 1.5, x1: wx + 1.5, z0: wz - 1.5, z1: wz + 1.5, y: wy, h: 10 }); }
  // wagons, parked: [x, z, along x?]
  for (const [wx, wz, ax, py] of [[2227, zs + 5, true, y], [1980.6, 1992, false, y], [place('timber').x - 30, place('timber').z + 1.5, true, place('timber').y], [place('dryfork').x - 4, place('dryfork').z + 2, false, place('dryfork').y]]) {
    const hx = ax ? 1.9 : 0.85, hz = ax ? 0.85 : 1.9; prop(ax ? 'wagonx' : 'wagonz', wx - hx, wx + hx, py, 1.35, wz - hz, wz + hz);
  }

  // ---- telegraph poles along the roads out of town, every 48 m on the right-hand side going out
  const poles = [];
  for (const rd of terrain.roads) {
    if (rd.id === 'main') continue;
    const line = []; let next = 30;
    for (let i = 1; i < rd.n; i++) {
      if (rd.cum[i] < next) continue;
      next = rd.cum[i] + 48;
      const dx = rd.x[i] - rd.x[i - 1], dz = rd.z[i] - rd.z[i - 1], l = Math.hypot(dx, dz) || 1, px = rd.x[i] - dz / l * 5.6, pz = rd.z[i] + dx / l * 5.6;
      let town = false; for (const p of terrain.places) if (Math.abs(pz - p.z) < p.r + 30 && Math.hypot(px - Math.min(Math.max(px, p.ax || p.x), p.bx || p.x), pz - p.z) < p.r + 14) town = true;
      const py = terrain.heightAt(px, pz);
      if (town || terrain.levelAt(px, pz) > py - 0.3) { line.push(null); continue; }
      boxes.solid(px - 0.13, px + 0.13, py - 1, py + 7.2, pz - 0.13, pz + 0.13);
      line.push({ x: px, y: py, z: pz });
    }
    poles.push(line);
  }

  return { buildings, props, streets, bridge, poles, jail };
}
