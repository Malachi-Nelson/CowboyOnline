// Gunfire, judged by the server. A shot reaches here as a line (where it left the gun and which way it went, from
// the shared step in guns.js) and a moment: when the shooter saw the world they aimed at. Everyone is put back where
// they were at that moment (lag compensation, from each body's last 1.6 s of positions), the line is traced
// against the buildings, trunks, ground and water as they are now and the bodies as they were then, and whatever it
// meets first is what was hit. Nothing a client says about what it hit is ever asked for or believed.
//
// The rewind goes back at most REWIND_MAX (400 ms). How far back a shot has to be judged is the time from the
// world being as the shooter saw it to their input being stepped: the half of the ping on the way down, how far in
// the past others are drawn (about 70 ms near by), the half of the ping on the way up, and the input buffer that
// smooths uneven arrival. Measured with two players and a running target (test/combat.test.js): 223 ms at 50 ms
// of ping, 326 ms at 150 and 360 ms at 200 (90th percentile). So 400 ms judges everyone up to about 200 ms of ping
// exactly as they saw it; anyone laggier has to lead their target a little, which keeps them from hitting people
// who reached cover long ago on everyone else's screen.
import { TICK_MS, REWIND_MAX, HP_MAX, KIND_HORSE, GR_DEAD } from '../../../shared/constants.js';
import { GUNS, falloff } from '../../../shared/sim/guns.js';
import { EV, ZONE, STRUCK } from '../../../shared/net/messages.js';
import { rayGround, rayPerson, rayHorse } from '../../../shared/world/raycast.js';
import { dismountSpot } from '../../../shared/sim/moveHorse.js';
import { yawOf, TAU } from '../../../shared/math.js';

export const HF = { RIDING: 1, DEAD: 2 };                        // what the history remembers besides position
const MULT = [0, 3, 1, 0.6, 0];                                   // damage by zone: none, head, body, legs, horse
export const RESPAWN_TICKS = 6 * 20;                             // a player is down this long before getting up again
const BODY_TICKS = 60 * 20;                                      // a dead bot lies this long before it is replaced
const REGEN_AFTER = 8 * 20, REGEN = 5 / 20;                      // health comes back 8 s after the last hit, 5 a second
const spot = { x: 0, z: 0 };
const yaw16 = (dx, dz) => Math.round((((yawOf(dx, dz) % TAU) + TAU) % TAU) / TAU * 65536) & 65535;

export class Combat {
  constructor(world) {
    this.w = world;
    this.g = { water: false }; this.pz = { zone: 0 }; this.p = { x: 0, y: 0, z: 0, yaw: 0, fl: 0 };
    this.res = { t: 0, struck: 0, target: null, zone: 0, x: 0, y: 0, z: 0 };
    this.stats = { shots: 0, hits: 0, kills: 0, clamped: 0, hinted: 0, rewindMsMax: 0, rewindMsSum: 0 };
  }

  // Where e was at server time ms, from its history: position between the two ticks either side, and the heading
  // and flags of the earlier one. Only whole ticks already finished are used.
  at(e, ms, out = this.p) {
    const W = this.w, newest = W.tick - 1, oldest = newest - (W.HIST - 2);
    let t = ms / TICK_MS; if (t > newest) t = newest; if (t < oldest) t = oldest;
    const a = Math.floor(t), f = t - a, H = e.hist, n = W.HIST, i = (((a % n) + n) % n) * 5, j = ((((a + 1) % n) + n) % n) * 5;
    if (f <= 0 || a + 1 > newest) { out.x = H[i]; out.y = H[i + 1]; out.z = H[i + 2]; }
    else { out.x = H[i] + (H[j] - H[i]) * f; out.y = H[i + 1] + (H[j + 1] - H[i + 1]) * f; out.z = H[i + 2] + (H[j + 2] - H[i + 2]) * f; }
    out.yaw = H[i + 3]; out.fl = H[i + 4];
    return out;
  }

  // e's actor fired this step. view: the server time (ms) of the world the shooter was looking at. hint: who was
  // under the sights and the moment they were seen there, or null.
  fire(e, view, hint) {
    const W = this.w, a = e.a, G = GUNS[a.fired], now = W.serverNow();
    let ms = view, age = now - ms;
    if (age > REWIND_MAX) { ms = now - REWIND_MAX; age = REWIND_MAX; this.stats.clamped++; } else if (age < 0) { ms = now; age = 0; }
    let hid = 0, hms = ms;
    if (hint && W.ents.has(hint.target)) {
      hid = hint.target; hms = hint.ms; this.stats.hinted++;
      if (now - hms > REWIND_MAX) { hms = now - REWIND_MAX; this.stats.clamped++; } else if (hms > now) hms = now;
    }
    this.stats.shots++; this.stats.rewindMsSum += age; if (age > this.stats.rewindMsMax) this.stats.rewindMsMax = age;
    const r = this.trace(e, a.ox, a.oy, a.oz, a.dx, a.dy, a.dz, G.range, ms, hid, hms);
    this.event({ type: EV.SHOT, id: e.id, gun: a.fired, yaw: yaw16(a.dx, a.dz), pitch: Math.round(Math.asin(a.dy < -1 ? -1 : a.dy > 1 ? 1 : a.dy) / TAU * 65536), dist: r.t, struck: r.struck }, e, null);
    if (W.law) W.law.onShot(e, a.ox, a.oz, r);
    if (r.target) {
      if (r.zone === ZONE.HORSE) this.event({ type: EV.HIT, id: r.target.id, by: e.id, zone: ZONE.HORSE, dmg: 0, yaw: yaw16(a.dx, a.dz), hp: 255 }, r.target, e);
      else this.hurt(r.target, Math.max(1, Math.min(255, Math.round(G.dmg * MULT[r.zone] * falloff(G, r.t)))), r.zone, e, yaw16(a.dx, a.dz));
    }
    return r;
  }

  // Trace a shot by e. Bodies are taken at time ms, except the hinted one (hid) at hms.
  trace(e, ox, oy, oz, dx, dy, dz, range, ms, hid = 0, hms = ms) {
    const W = this.w, F = W.field, res = this.res, s = e.s;
    // the shot starts on the camera's line beside the shooter's head; if that is through a wall, from the head
    const hx = s.x, hy = oy, hz = s.z, sx = ox - hx, sz = oz - hz, sl = Math.sqrt(sx * sx + sz * sz);
    if (sl > 1e-6 && F.boxes.ray(hx, hy, hz, sx / sl, 0, sz / sl, sl + 0.05) < sl + 0.05) { ox = hx; oz = hz; }
    let t = F.boxes.ray(ox, oy, oz, dx, dy, dz, range), struck = t < range ? STRUCK.WOOD : STRUCK.AIR;
    const tt = F.trees.ray(ox, oy, oz, dx, dy, dz, t); if (tt < t) { t = tt; struck = STRUCK.TREE; }
    const tg = rayGround(F.terrain, ox, oy, oz, dx, dy, dz, t, this.g); if (tg < t) { t = tg; struck = this.g.water ? STRUCK.WATER : STRUCK.GROUND; }
    let target = null, zone = 0;
    const L = W.list, h2 = dx * dx + dz * dz;
    for (let i = 0; i < L.length; i++) {
      const v = L[i];
      if (v === e || v === e.horse || v.gone) continue;
      // a quick look first: is it anywhere near the line, allowing for how far it could have moved since?
      const px = v.s.x - ox, pz = v.s.z - oz, along = h2 > 1e-9 ? (px * dx + pz * dz) / Math.sqrt(h2) : 0;
      if (along < -8 || along > t * Math.sqrt(h2) + 8) continue;
      const off2 = px * px + pz * pz - along * along; if (off2 > 100) continue;
      const p = this.at(v, v.id === hid ? hms : ms);
      if (v.kind === KIND_HORSE) {
        const th = rayHorse(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z, p.yaw, t);
        if (th < t) { t = th; target = v; zone = ZONE.HORSE; struck = STRUCK.HORSE; }
      } else {
        if (p.fl & HF.DEAD) continue;
        const tp = rayPerson(ox, oy, oz, dx, dy, dz, p.x, p.y, p.z, (p.fl & HF.RIDING) !== 0, t, this.pz);
        if (tp < t) { t = tp; target = v; zone = this.pz.zone; struck = STRUCK.BODY; }
      }
    }
    res.t = t; res.struck = struck; res.target = target; res.zone = zone;
    res.x = ox + dx * t; res.y = oy + dy * t; res.z = oz + dz * t;
    return res;
  }

  // ---- damage, death, getting up again
  hurt(v, dmg, zone, by, yaw) {
    const W = this.w, a = v.a;
    if (!a || a.dead || a.jail) return;
    this.stats.hits++;
    v.hp -= dmg; v.hurtAt = W.tick; if (by) v.lastHurtBy = by.id;
    if (v.hp < 0) v.hp = 0;
    this.event({ type: EV.HIT, id: v.id, by: by ? by.id : 0, zone, dmg, yaw, hp: Math.ceil(v.hp) }, v, by);
    if (W.law) W.law.onHurt(by, v, v.hp <= 0);
    if (v.bot) v.bot.onHurt(by, W.tick);
    if (v.hp <= 0) this.kill(v, by, zone);
  }
  kill(v, by, zone) {
    const W = this.w, a = v.a;
    this.stats.kills++;
    a.dead = 1; v.deadAt = W.tick; v.killedBy = by ? by.id : 0;
    if (a.riding && a.h) {                                       // out of the saddle and down
      dismountSpot(a.h, W.field, spot); const r = Math.fround, f = a.f;
      f.x = r(spot.x); f.z = r(spot.z); f.vx = 0; f.vz = 0; f.vy = 0; f.ground = 0; a.riding = 0;
    }
    a.slot = 0; a.swap = 0; a.rel = 0; a.gfl = 0; a.aimT = 0;
    this.event({ type: EV.DIE, id: v.id, by: by ? by.id : 0, zone }, v, by);
    if (W.law) W.law.onKill(by, v);
    if (v.bot) v.bot.onDeath(W.tick);
  }
  // put a player back on their feet: full health, guns loaded, at (x, z)
  revive(v, x, z) {
    const W = this.w, a = v.a, f = a.f, T = W.field.terrain, r = Math.fround;
    a.dead = 0; v.hp = HP_MAX; v.hurtAt = -1e9; v.deadAt = 0;
    f.x = r(x); f.z = r(z); f.y = r(W.field.groundAt(x, z, T.heightAt(x, z) + 1)); f.vx = 0; f.vy = 0; f.vz = 0; f.ground = 1; a.riding = 0;
    a.m1 = GUNS[1].mag; a.m2 = GUNS[2].mag; if (a.r1 < GUNS[1].spare) a.r1 = GUNS[1].spare; if (a.r2 < GUNS[2].spare) a.r2 = GUNS[2].spare;
    a.slot = 0; a.swap = 0; a.rel = 0; a.cool = 0; a.bloom = 0;
    if (a.h && v.horse) {                                       // the horse is waiting nearby
      const h = a.h; h.x = r(x + 2.2); h.z = r(z); h.y = r(T.heightAt(h.x, h.z)); h.sp = 0; h.vy = 0; h.ground = 1; h.mode = 0;
    }
    W.moved(v);
  }
  tick() {
    const W = this.w, tick = W.tick;
    for (const p of W.people) {
      if (p.a.dead) { if (tick - p.deadAt >= RESPAWN_TICKS) (W.law ? W.law.afterDeath(p) : this.revive(p, ...W.spawnPoint())); }
      else if (p.hp < HP_MAX && tick - p.hurtAt > REGEN_AFTER && !p.a.jail) { p.hp += REGEN; if (p.hp > HP_MAX) p.hp = HP_MAX; }
    }
    for (const b of W.bots) if (b.e.a.dead && tick - b.e.deadAt >= BODY_TICKS) b.respawn(tick);
  }

  // tell everyone who can see `a` (or `b`) about something that happened
  event(ev, a, b) {
    for (const c of this.w.clients) {
      const p = c.player; if (!p) continue;
      let ok = p === a || p === b;
      if (!ok && a) { const rec = c.view.get(a.id); ok = !!(rec && rec.known); }
      if (!ok && b) { const rec = c.view.get(b.id); ok = !!(rec && rec.known); }
      if (ok && c.events.length < 48) c.events.push(ev);
    }
  }
}
export const isDead = e => (e.gear & GR_DEAD) !== 0;
