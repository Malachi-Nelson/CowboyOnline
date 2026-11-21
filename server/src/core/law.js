// The law in Calder Territory: who saw what, who went to tell, who the law wants, the lawmen who go looking, the
// posse that rides out for the worst of it, and the cell behind the sheriff's office.
//
// A crime is hurting or killing someone who had not shot at you first and is not wanted themselves. Nothing happens
// unless somebody saw it: a lawman who sees it acts at once; townsfolk who see it run to the sheriff, and if one of
// them gets there (ten seconds on their feet) the law is told. A crime nobody lives to report is not on anyone's
// books. Once wanted, a player has a bounty and the law searches the place it last saw them, a circle that widens
// the longer they stay out of sight. Out of the circle and unseen for twenty seconds, they have got away (the bounty
// stays on the books for the bounty hunters of Phase 6). Seen again, they are shot at. Killing a lawman, or a
// bounty past $40, sends a posse. Hands up near a lawman, or being killed by the law, ends in the cell: ten
// seconds and half a second for every dollar, then out at the office door with the slate wiped clean.
import { TICK_RATE, HP_MAX, EF_LAW, KIND_HORSE } from '../../../shared/constants.js';
import { NOTE } from '../../../shared/net/messages.js';
import { GF, AIM, GUNS, WEAPON_SHIFT, magOf } from '../../../shared/sim/guns.js';
import { BTN } from '../../../shared/sim/moveFoot.js';
import { HORSE } from '../../../shared/sim/moveHorse.js';
import { SIN16, COS16 } from '../../../shared/sim/trig.js';
import { TAU, yawOf } from '../../../shared/math.js';

export const LAW = {
  assault: 5, murder: 15, lawAssault: 10, lawMurder: 35,          // dollars
  see: 70, hear: 120, witness: 55,                                 // m: how far a lawman sees, hears a shot, a townsman sees
  look: 20 * TICK_RATE,                                            // how long a lawman goes looking where he heard shooting
  report: 10 * TICK_RATE,                                          // a witness on their feet this long has told the law
  escape: 20 * TICK_RATE, giveUp: 75 * TICK_RATE,                  // out of the circle and unseen this long; unseen anywhere
  search0: 60, searchGrow: 3, searchMax: 160,                      // m, m a second, m
  posseAt: 40, posseSize: 3, posseMax: 12,                        // bounty that sends a posse, how many ride, and most riding at once
  selfDefence: 30 * TICK_RATE,                                     // shooting back at someone who shot you is not a crime, for this long
  jailBase: 10, jailPerDollar: 0.5, jailMax: 60,                   // seconds
  arrest: 2.6, arrestTicks: 1.5 * TICK_RATE,                       // how close, and how long, a lawman stands at someone with their hands up
};
const yaw16 = r => Math.round((((r % TAU) + TAU) % TAU) / TAU * 65536) & 65535;
const WP = n => n << WEAPON_SHIFT;                               // the gun a bot wants in hand, as button bits

// what the law has on a player. seenAt: the last time the law knew where they were (a lawman's eyes, or a report).
// charged: per victim, the most they have been charged for (hurting, then killing, the same man is a murder, not both)
export function makeRecord() { return { wanted: 0, bounty: 0, pending: 0, sx: 0, sz: 0, sr: 0, seen: false, seenAt: -1e9, lastX: 0, lastZ: 0, witnesses: 0, jailUntil: 0, surrender: false, holdAt: 0, posse: false, charged: new Map() }; }

export class Law {
  constructor(world) {
    this.w = world; this.jail = world.field.jail;
    this.witnesses = [];                                           // { bot, criminal, value, at }
    this.lawmen = [];
    this.attacks = new Map();                                      // `${a}>${b}` -> tick a last hurt b
    this.stats = { crimes: 0, unseen: 0, reported: 0, seenByLaw: 0, escapes: 0, arrests: 0, jailed: 0, posses: 0 };
  }
  record(p) { return p.law || (p.law = makeRecord()); }
  isLaw(e) { return (e.ef & EF_LAW) !== 0; }
  note(p, code, value = 0) { const c = p.client; if (c && c.events.length < 48) c.events.push({ type: 4, code, value }); }

  // ---- what the combat code tells the law
  onShot(e, x, z, r) {
    // townsfolk near the shot (or where it landed) scatter; a lawman in earshot comes to see what it was
    const law = this.isLaw(e);
    for (const b of this.w.bots) {
      if (b.e.a.dead || b.role === 'posse') continue;
      const s = b.e.s, d1 = (s.x - x) ** 2 + (s.z - z) ** 2, d2 = (s.x - r.x) ** 2 + (s.z - r.z) ** 2;
      if (b.role === 'law') { if (!law && d1 < LAW.hear * LAW.hear) b.hear(x, z, this.w.tick); }
      else if (d1 < 35 * 35 || d2 < 12 * 12) b.scare(x, z, this.w.tick);
    }
  }
  onHurt(by, v, killed) {
    const W = this.w; if (!by || by === v || !by.a) return;
    this.attacks.set(by.id + '>' + v.id, W.tick);
    if (by.bot) return;                                            // lawmen and townsfolk are not charged
    this.killing = killed;
    const vr = v.law;
    if (vr && vr.wanted) return;                                   // the wanted are fair game
    const back = this.attacks.get(v.id + '>' + by.id);
    if (back !== undefined && W.tick - back < LAW.selfDefence) return;   // they shot first
    const law = this.isLaw(v), value = killed ? (law ? LAW.lawMurder : LAW.murder) : (law ? LAW.lawAssault : LAW.assault);
    this.dying = killed ? v : null; this.crime(by, value, law && killed, v); this.dying = null;
  }
  onKill(by, v) { if (v.bot && this.isLaw(v)) { const r = by && !by.bot ? this.record(by) : null; if (r && r.wanted) this.escalate(by, 3); } }

  // a crime by player p: who saw it?
  crime(p, value, grave, victim) {
    const W = this.w, s = p.s, r = this.record(p); this.stats.crimes++;
    let lawSaw = false, seen = 0, fresh = 0;
    const saw = this.saw || (this.saw = []); saw.length = 0;
    for (const list of [W.bots, W.posse]) for (const b of list) {
      const e = b.e; if (e.a.dead || e === victim && !this.isLaw(e)) continue;
      const law = b.role === 'law' || b.role === 'posse', range = law ? LAW.see : LAW.witness;
      const dx = e.s.x - s.x, dz = e.s.z - s.z; if (dx * dx + dz * dz > range * range) continue;
      if (!this.sees(e, p)) continue;
      if (law) lawSaw = true;
      else if (!b.witness) saw.push(b);
      else if (b.witness.criminal === p) seen++;
    }
    // a victim who lives through it tells it too
    if (victim && victim.bot && !this.killing && !victim.a.dead && !this.isLaw(victim) && !victim.bot.witness) saw.push(victim.bot);
    // if the law saw it there is nobody to run and tell
    if (!lawSaw) for (const b of saw) { b.witness = { criminal: p, at: W.tick }; this.witnesses.push(b); seen++; fresh++; }
    if (!lawSaw && !seen) { this.stats.unseen++; return; }
    // hurting someone, then killing them, is charged as the killing
    const prev = victim ? r.charged.get(victim.id) || 0 : 0, add = value > prev ? value - prev : 0;
    if (victim) r.charged.set(victim.id, prev + add);
    if (lawSaw) { this.report(p, add, true); if (grave) this.escalate(p, 3); return; }
    r.pending += add; r.witnesses = this.witnessesOf(p);
    if (fresh) this.note(p, NOTE.WITNESS, r.witnesses);
  }
  witnessesOf(p) { let n = 0; for (const b of this.witnesses) if (b.witness && b.witness.criminal === p && !b.e.a.dead && b.e !== this.dying) n++; return n; }
  // the law hears of it: wanted, with the search on where they were
  report(p, value, bySight) {
    const r = this.record(p), s = p.s, was = r.wanted;
    r.bounty += value + r.pending; r.pending = 0;
    r.wanted = Math.max(r.wanted, bySight ? 2 : 1); r.sx = s.x; r.sz = s.z; r.sr = LAW.search0; r.lastX = s.x; r.lastZ = s.z; r.seenAt = this.w.tick;
    if (bySight) { r.seen = true; this.stats.seenByLaw++; } else this.stats.reported++;
    if (!was) this.note(p, NOTE.WANTED, r.bounty); else if (!bySight) this.note(p, NOTE.REPORTED, 0);
    if (r.bounty >= LAW.posseAt) this.escalate(p, 3);
  }
  escalate(p, level) {
    const r = this.record(p); if (r.wanted < level) r.wanted = level;
    if (level >= 3 && !r.posse && this.sendPosse(p)) { r.posse = true; this.stats.posses++; this.note(p, NOTE.POSSE, 0); }
  }

  // ---- can e see p? Eyes to eyes, nothing built in between and the ground not in the way
  sees(e, p) {
    const F = this.w.field, a = e.s, b = p.s, ay = a.y + (e.a && e.a.riding ? 2.4 : 1.6), by = b.y + (p.a && p.a.riding ? 2.4 : 1.4);
    const dx = b.x - a.x, dy = by - ay, dz = b.z - a.z, l = Math.sqrt(dx * dx + dy * dy + dz * dz); if (l < 1) return true;
    if (F.boxes.ray(a.x, ay, a.z, dx / l, dy / l, dz / l, l) < l - 0.5) return false;
    const T = F.terrain; for (let k = 1; k < 6; k++) { const f = k / 6; if (T.heightAt(a.x + dx * f, a.z + dz * f) > ay + dy * f) return false; }
    return true;
  }

  // ---- once a tick
  tick() {
    const W = this.w, tick = W.tick;
    // witnesses: those still on their feet long enough have told the law; the dead tell nobody
    for (let i = this.witnesses.length - 1; i >= 0; i--) {
      const b = this.witnesses[i], wt = b.witness;
      if (!wt) { this.witnesses.splice(i, 1); continue; }
      const p = wt.criminal;
      if (b.e.a.dead || p.gone) { b.witness = null; this.witnesses.splice(i, 1); if (!p.gone) this.record(p).witnesses = this.witnessesOf(p); continue; }
      if (tick - wt.at >= LAW.report) {
        b.witness = null; this.witnesses.splice(i, 1);
        const r = this.record(p); if (r.jailUntil) continue;
        this.report(p, 0, false); r.witnesses = this.witnessesOf(p);
        // whoever else was on their way has nothing left to add
        for (const o of this.witnesses) if (o.witness && o.witness.criminal === p) o.witness.at = Math.min(o.witness.at, tick - LAW.report + 20);
      }
    }
    if (tick % 4 !== 0) return;
    for (const p of W.people) {
      const r = p.law; if (!r) continue;
      r.witnesses = r.pending ? this.witnessesOf(p) : 0;
      if (r.jailUntil) { if (tick >= r.jailUntil) this.release(p); continue; }
      if (r.pending && !this.witnessesOf(p)) { r.pending = 0; r.witnesses = 0; }   // every witness silenced
      if (!r.wanted) continue;
      // does any lawman see them?
      let seen = false, near = null, nd = 1e9;
      for (const b of this.lawmen) {
        const e = b.e; if (e.a.dead) continue;
        const dx = e.s.x - p.s.x, dz = e.s.z - p.s.z, d2 = dx * dx + dz * dz;
        if (d2 > LAW.see * LAW.see) continue;
        if (this.sees(e, p)) { seen = true; if (d2 < nd) { nd = d2; near = b; } }
      }
      if (seen) {
        if (!r.seen) this.note(p, NOTE.LAW_SEES, 0);
        r.seen = true; r.seenAt = tick; r.sx = r.lastX = p.s.x; r.sz = r.lastZ = p.s.z; r.sr = LAW.search0;
        if (r.wanted < 2) r.wanted = 2;
      } else {
        if (r.seen && tick - r.seenAt > TICK_RATE) { r.seen = false; this.note(p, NOTE.LOST_THEM, 0); }
        r.sr = Math.min(LAW.searchMax, LAW.search0 + (tick - r.seenAt) / TICK_RATE * LAW.searchGrow);
        const out = (p.s.x - r.sx) ** 2 + (p.s.z - r.sz) ** 2 > r.sr * r.sr;
        if ((out && tick - r.seenAt > LAW.escape) || tick - r.seenAt > LAW.giveUp) { this.stats.escapes++; this.clear(p); this.note(p, NOTE.ESCAPED, r.bounty); continue; }
      }
      // hands up where a lawman can see it, and one of them close enough to take them in
      r.surrender = !!(p.a.gfl & GF.HANDS) && seen;
      if (r.surrender && near && nd < LAW.arrest * LAW.arrest) { if (!r.holdAt) r.holdAt = tick; else if (tick - r.holdAt >= LAW.arrestTicks) { this.stats.arrests++; this.note(p, NOTE.ARRESTED, 0); this.toJail(p); } }
      else r.holdAt = 0;
    }
  }
  clear(p) { const r = this.record(p); r.wanted = 0; r.seen = false; r.sr = 0; r.surrender = false; r.holdAt = 0; r.posse = false; r.charged.clear(); for (const b of this.lawmen) if (b.target === p) b.target = null; }

  // ---- after a player dies: up again on the street, or, if the law killed them, in the cell
  afterDeath(p) {
    const r = this.record(p), killer = this.w.ents.get(p.killedBy);
    if (r.wanted && killer && this.isLaw(killer)) { this.toJail(p); return; }
    if (r.wanted) { r.seen = false; r.seenAt = this.w.tick; }       // a fresh start, but still wanted
    this.w.combat.revive(p, ...this.w.spawnPoint());
  }
  toJail(p) {
    const r = this.record(p), J = this.jail, W = this.w;
    const secs = Math.min(LAW.jailMax, LAW.jailBase + r.bounty * LAW.jailPerDollar);
    this.clear(p); r.bounty = 0; r.pending = 0; r.jailUntil = W.tick + Math.round(secs * TICK_RATE); this.stats.jailed++;
    W.combat.revive(p, J.x, J.z); p.a.jail = 1; p.a.slot = 0; p.a.swap = 0;
    if (p.a.h) { const h = p.a.h, r2 = Math.fround; h.x = r2(J.door.x + 3); h.z = r2(J.door.z - 2); h.y = r2(W.field.terrain.heightAt(h.x, h.z)); h.sp = 0; h.mode = 0; if (p.horse) W.moved(p.horse); }
    for (const b of this.witnesses) if (b.witness && b.witness.criminal === p) b.witness = null;
  }
  release(p) {
    const r = this.record(p), J = this.jail; r.jailUntil = 0;
    this.w.combat.revive(p, J.door.x, J.door.z); p.a.jail = 0;
    this.note(p, NOTE.RELEASED, 0);
  }

  // ---- the posse: three lawmen on horses, brought in out of sight behind the wanted man, riding him down. There are
  // only so many to go round: with a dozen already riding, nobody new is sent (those riding take on whoever is
  // nearest once their own man is dealt with). Returns how many rode out.
  sendPosse(p) {
    const W = this.w, F = W.field, T = F.terrain, s = p.s, n = Math.min(LAW.posseSize, LAW.posseMax - W.posse.length);
    for (let k = 0; k < n; k++) {
      let x = s.x, z = s.z;
      for (let tries = 0; tries < 12; tries++) {
        const a = W.rand() * TAU, d = 140 + W.rand() * 40; x = s.x + Math.cos(a) * d; z = s.z + Math.sin(a) * d;
        if (x < 30 || z < 30 || x > 4066 || z > 4066) continue;
        if (T.levelAt(x, z) - T.heightAt(x, z) > 0.3) continue;
        if (F.boxes.pushOut(x, z, 1.4, T.heightAt(x, z) + 0.5, T.heightAt(x, z) + 2)) continue;
        break;
      }
      W.addLawman('posse', x, z, p);
    }
    return n > 0 ? n : 0;
  }
}

// ---- a lawman's mind. Driven like any bot: it fills in an input each tick and the shared step moves it.
// role 'law': one of the sheriff's men in Calder's Landing; 'posse': a rider sent after one wanted man.
export class Lawman {
  constructor(e, rand, role, field, law, target = null) {
    this.e = e; this.rand = rand; this.role = role; this.field = field; this.law = law; this.target = target;
    this.cmd = { mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };
    this.gun = role === 'posse' || (e.id & 1) ? 2 : 1;           // repeaters for the riders and every other deputy
    this.tx = e.s.x; this.tz = e.s.z; this.wait = 0; this.until = 0; this.fireAt = 0; this.pressed = false; this.lost = 0;
    this.skill = role === 'posse' ? 0.8 : 1; this.home = law.jail ? law.jail.door : { x: e.s.x, z: e.s.z }; this.deadAt = 0; this.strafe = 0; this.strafeAt = 0; this.leaveAt = 0;
  }
  get witness() { return null; }
  scare() {}
  // shooting heard: go and look, gun in hand (whoever is still at it when he gets there is seen doing it)
  hear(x, z, tick) { if (this.role === 'law') this.alarm = { x: x + (this.rand() - 0.5) * 8, z: z + (this.rand() - 0.5) * 8, until: tick + LAW.look }; }
  onHurt(by) { if (by && !by.bot && !this.target) this.target = by; }
  onDeath(tick) { this.deadAt = tick; }
  respawn(tick) {
    const world = this.law.w;
    if (this.role === 'posse') { world.removeLawman(this); return; }
    const d = this.home; world.combat.revive(this.e, d.x + (this.rand() - 0.5) * 6, d.z - 1 - this.rand() * 3); this.target = null; this.alarm = null; void tick;
  }
  // who to go after: a wanted man the law knows about, nearest first
  pick() {
    const world = this.law.w, s = this.e.s; let best = null, bd = 1e9;
    for (const p of world.people) {
      const r = p.law; if (!r || !r.wanted || p.a.dead || r.jailUntil) continue;
      const d = (p.s.x - s.x) ** 2 + (p.s.z - s.z) ** 2 + (this.role === 'posse' && p === this.target ? -1e7 : 0);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  think(t) {
    const e = this.e, a = e.a, s = e.s, c = this.cmd, r = this.rand;
    c.mx = 0; c.mz = 0; c.buttons = WP(0);
    if (a.dead) return;
    if (this.pressed) { this.pressed = false; c.buttons = WP(a.slot); return; }
    let p = this.target && this.target.law && this.target.law.wanted && !this.target.a.dead && !this.target.law.jailUntil ? this.target : this.pick();
    this.target = p;
    if (this.role === 'posse' && !p) { this.rideOff(); return; }
    if (!p) { this.patrol(t); return; }
    const L = p.law, ps = p.s, dx = ps.x - s.x, dz = ps.z - s.z, d = Math.sqrt(dx * dx + dz * dz);
    const visible = d < LAW.see && this.law.sees(e, p);
    const gunUp = WP(this.gun);
    if (L.surrender && visible) {                                  // hands up: walk up and take them
      c.buttons = WP(0); if (a.riding && d < 12) { c.buttons |= BTN.USE; this.pressed = true; return; }
      if (d > LAW.arrest * 0.8) this.go(ps.x, ps.z, d > 12 ? 0 : BTN.WALK);
      return;
    }
    if (visible) {
      this.lost = 0;
      // keep a working distance, sidestep now and then (or circle, in the saddle), and shoot when the gun is up and steady
      const want = a.riding ? 24 : 16;
      let pace = 0;
      if (t > this.strafeAt) { this.strafe = r() < 0.4 ? -1 : r() < 0.66 ? 1 : 0; this.strafeAt = t + 1 + r() * 2; }
      if (d > want + 8) { c.mz = 127; pace = a.riding ? 0 : BTN.SPRINT; }
      else if (d < (a.riding ? 10 : 7)) c.mz = -127;
      else { c.mx = (this.strafe || (a.riding ? 1 : 0)) * (a.riding ? 127 : 90); pace = a.riding ? BTN.WALK : 0; }
      this.aim(p, d);
      c.buttons = gunUp | BTN.AIM | pace;
      if (a.slot === this.gun && a.aimT > 30 && t >= this.fireAt && a.cool === 0) {
        if (magOf(a) > 0) { c.buttons |= BTN.FIRE; this.fireAt = t + (a.riding ? 1.6 : 1.1) + r() * 1.2; }
        else c.buttons |= BTN.RELOAD;
      }
      return;
    }
    // not in sight: go to where the law last knew them to be, then look around the circle
    c.buttons = gunUp | (a.rel || magOf(a) < (GUNS[this.gun].mag >> 1) ? BTN.RELOAD : 0);
    const tx = this.lost > 0 && this.role !== 'posse' ? this.tx : (this.role === 'posse' ? ps.x : L.lastX), tz = this.lost > 0 && this.role !== 'posse' ? this.tz : (this.role === 'posse' ? ps.z : L.lastZ);
    const gx = tx - s.x, gz = tz - s.z;
    if (gx * gx + gz * gz < 9 || t > this.until) { this.lost++; const ang = r() * TAU, rr = r() * Math.max(10, L.sr * 0.7); this.tx = L.sx + Math.cos(ang) * rr; this.tz = L.sz + Math.sin(ang) * rr; this.until = t + 8 + r() * 6; }
    this.go(tx, tz, BTN.SPRINT);
  }
  // point the gun at p's chest, give or take this lawman's aim
  aim(p, d) {
    const e = this.e, a = e.a, c = this.cmd, r = this.rand, ps = p.s, riding = a.riding !== 0;
    const sp = p.a.riding && p.a.h ? Math.abs(p.a.h.sp) : Math.hypot(ps.vx, ps.vz);
    const err = (0.03 + d * 0.0005 + sp * 0.007 + (riding ? 0.02 : 0)) / this.skill;
    const ty = ps.y + (p.a.riding ? 2.0 : 1.15);
    let yaw = (c.yaw / 65536) * TAU, pitch = 0;
    for (let k = 0; k < 3; k++) {
      const yi = yaw16(yaw), sh = riding ? AIM.rideShoulder : AIM.shoulder, hd = (riding ? AIM.rideHead : AIM.head) + AIM.up;
      const ox = a.f.x + COS16[yi] * sh, oy = a.f.y + hd, oz = a.f.z - SIN16[yi] * sh, dx = ps.x - ox, dy = ty - oy, dz = ps.z - oz;
      yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz));
    }
    if (a.aimT === 0 || r() < 0.08) { this.ex = (r() - 0.5) * 2 * err; this.ey = (r() - 0.5) * 2 * err; }   // the wobble changes now and then
    c.yaw = yaw16(yaw + (this.ex || 0)); c.pitch = Math.round((pitch + (this.ey || 0)) / TAU * 65536);
  }
  // walk or ride toward (x, z)
  go(x, z, pace, rein = false) {
    const s = this.e.s, c = this.cmd, dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < 0.5) return;
    c.yaw = yaw16(yawOf(dx, dz)); c.mz = rein ? -127 : 127; c.buttons = (c.buttons & ~(BTN.SPRINT | BTN.WALK)) | pace;
  }
  // up and down the main street, a few paces at a time; or, with shooting heard, to where it was
  patrol(t) {
    const s = this.e.s, c = this.cmd, r = this.rand, a = this.e.a, al = this.alarm;
    if (a.riding) { c.buttons |= BTN.USE; this.pressed = true; return; }
    if (al) {
      if (this.law.w.tick > al.until) { this.alarm = null; this.wait = 1; }
      else {
        const dx = al.x - s.x, dz = al.z - s.z;
        c.buttons = WP(this.gun);
        if (dx * dx + dz * dz > 25) { c.yaw = yaw16(yawOf(dx, dz)); c.mz = 127; c.buttons |= BTN.SPRINT; }
        else if (r() < 0.02) c.yaw = (c.yaw + ((r() - 0.5) * 24000) | 0) & 65535;   // there: look about
        return;
      }
    }
    if (this.wait > 0) { this.wait -= 1 / TICK_RATE; return; }
    const dx = this.tx - s.x, dz = this.tz - s.z;
    if (dx * dx + dz * dz < 2.5 || t > this.until) {
      const S = this.beat !== undefined ? this.beat : (this.beat = this.field.streets.find(q => q.place === 'hub') || null), h = this.home;
      if (S) { this.tx = S.x0 + r() * (S.x1 - S.x0); this.tz = S.z0 + 2 + r() * (S.z1 - S.z0 - 4); }
      else { this.tx = h.x + (r() - 0.5) * 120; this.tz = h.z + (r() - 0.5) * 6; }
      this.until = t + 45; this.wait = 2 + r() * 8; return;
    }
    c.yaw = yaw16(yawOf(dx, dz)); c.mz = 127; c.buttons = WP(0) | BTN.WALK;
  }
  rideOff() {
    const s = this.e.s, c = this.cmd, world = this.law.w;
    if (!this.leaveAt) this.leaveAt = world.tick + 20 * TICK_RATE;
    if (world.tick > this.leaveAt) { world.removeLawman(this); return; }
    c.yaw = yaw16(yawOf(s.x - this.law.jail.door.x, s.z - this.law.jail.door.z)); c.mz = 127; c.buttons = WP(0);
  }
}
