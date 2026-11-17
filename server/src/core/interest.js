// The interest grid: the world cut into 128 m squares, each holding the entities standing in it. A player's view
// is built from the squares around them, so the cost of finding who is near does not grow with the whole world.
import { CHUNK, GRID_N } from '../../../shared/constants.js';

const cellIndex = v => { const c = (v / CHUNK) | 0; return c < 0 ? 0 : c >= GRID_N ? GRID_N - 1 : c; };

export class InterestGrid {
  constructor() {
    this.cells = new Array(GRID_N * GRID_N);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }
  cellOf(x, z) { return cellIndex(z) * GRID_N + cellIndex(x); }
  add(e) { e.cell = this.cellOf(e.s.x, e.s.z); this.cells[e.cell].push(e); }
  remove(e) {
    if (e.cell < 0) return;
    const L = this.cells[e.cell], i = L.indexOf(e);
    if (i >= 0) { L[i] = L[L.length - 1]; L.pop(); }
    e.cell = -1;
  }
  move(e) {
    const c = this.cellOf(e.s.x, e.s.z);
    if (c !== e.cell) { this.remove(e); e.cell = c; this.cells[c].push(e); }
  }
  // Appends to `out` every entity in a square the circle could touch. The caller checks the exact distance.
  query(x, z, r, out) {
    const x0 = cellIndex(x - r), x1 = cellIndex(x + r), z0 = cellIndex(z - r), z1 = cellIndex(z + r);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const L = this.cells[cz * GRID_N + cx];
      for (let i = 0; i < L.length; i++) out.push(L[i]);
    }
    return out;
  }
}
