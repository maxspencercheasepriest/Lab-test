// Enemies: the Prefect (grabs you and drags you to Correction) and Orderlies (beat you down).
//
// They don't know where you are. They patrol the wing room to room, lingering, looking about
// and poking into hiding places. Seeing you builds *suspicion* — a glimpse makes them come and
// look, a good look starts a chase. Noises send them to investigate. Lose them, and they search
// the area for a while before going back to their rounds.
import { ENEMIES, DETECT } from '../shared/constants.js';
import { TILE, MAP, ROOMS, toTile, tileCenter } from '../shared/map.js';
import { findPath, lineOfSight, collideCircle, tkey, isSolidTile } from '../shared/grid.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const angleDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const FLOOR = new Set(['.', '*', 'S', 'X', 'O', 'K', 'H']);

export class Enemy {
  constructor(game, id, kind, spawnTile) {
    this.game = game;
    this.id = id;
    this.kind = kind;
    this.cfg = ENEMIES[kind];
    const c = tileCenter(spawnTile);
    this.x = c.x; this.z = c.z; this.yaw = Math.random() * Math.PI * 2;
    this.state = 'patrol';
    this.stateTime = 0;
    this.path = null; this.pathIdx = 0; this.finalPoint = null;
    this.pause = rand(1, 3);
    this.target = null;
    this.lastSeen = null;
    this.lostFor = 0;
    this.repathIn = 0;
    this.speedMul = 1;
    this.moving = false;
    this.suspicion = new Map();   // playerId -> 0..1
    this.recentSight = new Map(); // playerId -> time last seen
    this.recentRooms = [];
    this.room = null;
    this.lingerLeft = 0;
    this.roomMoveIn = 0;
    this.hideTarget = null;       // a hiding place it's walking over to check
    this.knownHide = null;        // a hiding place it saw someone get into
    this.curious = null;          // { x, z, id } — a glimpse it's following up
    this.curiousRepath = 0;
    this.attackT = 0;
    this.cooldown = 0;
    this.stunUntil = 0;
    this.grabbing = null;
  }

  get speed() {
    const c = this.cfg;
    let base = c.patrolSpeed;
    if (this.state === 'chase') base = c.chaseSpeed;
    else if (this.state === 'investigate') base = this.curious ? c.patrolSpeed * 1.15 : c.investigateSpeed;
    else if (this.state === 'attack') base = c.patrolSpeed * 0.5;
    return base * this.speedMul;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    this.game.onEnemyState(this, s);
  }

  // ---- movement helpers --------------------------------------------------

  goTo(wx, wz) {
    const dyn = this.game.dyn;
    const from = toTile(this.x, this.z);
    let to = toTile(wx, wz);
    const opts = { doorsPassable: true };
    if (isSolidTile(to.x, to.z, dyn, opts)) {
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: to.x + dx, z: to.z + dz }))
        .filter(t => !isSolidTile(t.x, t.z, dyn, opts))
        .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
      if (!n.length) return false;
      to = n[0];
      wx = tileCenter(to).x; wz = tileCenter(to).z;
    }
    const p = findPath(from, to, dyn);
    if (!p) return false;
    this.path = p; this.pathIdx = 1;
    this.finalPoint = { x: wx, z: wz };
    return true;
  }

  arrived() { return !this.path || this.pathIdx >= this.path.length; }

  followPath(dt) {
    if (this.arrived()) { this.moving = false; return; }
    const wp = this.path[this.pathIdx];
    const last = this.pathIdx === this.path.length - 1;
    if (MAP[wp.z][wp.x] === 'D' && !this.game.dyn.doors.get(tkey(wp.x, wp.z))) {
      const c = tileCenter(wp);
      if (Math.hypot(c.x - this.x, c.z - this.z) < TILE * 1.2) {
        this.game.setDoor(wp, true, 'enemy');
        this.pause = this.state === 'chase' ? 0.15 : this.cfg.doorPause;
        return;
      }
    }
    let c = tileCenter(wp);
    if (last && this.finalPoint) {
      const ft = toTile(this.finalPoint.x, this.finalPoint.z);
      if (!isSolidTile(ft.x, ft.z, this.game.dyn, { doorsPassable: true })) c = this.finalPoint;
    }
    if (Math.hypot(c.x - this.x, c.z - this.z) < 0.25) { this.pathIdx++; return; }
    this.moveToward(c.x, c.z, dt);
  }

  moveToward(x, z, dt, speed = this.speed) {
    const dx = x - this.x, dz = z - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.01) { this.moving = false; return; }
    const step = Math.min(d, speed * dt);
    const p = collideCircle(this.x + (dx / d) * step, this.z + (dz / d) * step, this.cfg.radius, this.game.dyn);
    this.moving = Math.hypot(p.x - this.x, p.z - this.z) > 0.001;
    this.x = p.x; this.z = p.z;
    this.turnTo(Math.atan2(dx, dz), dt, 8);
  }

  turnTo(yaw, dt, rate = 6) { this.yaw += angleDiff(yaw, this.yaw) * Math.min(1, dt * rate); }

  // ---- senses ------------------------------------------------------------

  // How well can it see this player right now? 0 = not at all.
  visibility(p) {
    const c = this.cfg;
    const dx = p.x - this.x, dz = p.z - this.z;
    const dist = Math.hypot(dx, dz);
    let range = c.viewDistance * (this.game.lightsOut ? 0.75 : 1);
    if (dist > range) return 0;
    if (!lineOfSight(this.x, this.z, p.x, p.z, this.game.dyn)) return 0;
    const inCone = Math.abs(angleDiff(Math.atan2(dx, dz), this.yaw)) <= c.viewHalfAngle;
    if (!inCone) {
      // Out of its view: it only notices you if you're right behind it and making a fuss.
      if (dist < 3 && p.moving && !p.crouch) return 0.6;
      return 0;
    }
    const close = 1 - dist / range;
    let v = 0.25 + 1.5 * Math.pow(close, 1.5);
    if (p.crouch) v *= 0.45;
    if (!p.moving) v *= 0.6;
    if (p.running) v *= 1.6;
    if (this.kind === 'prefect' && dist < 4 && !this.game.lightsOut) v *= 1.4; // in its lantern light
    return v;
  }

  hear(x, z, radius) {
    if (radius <= 0) return false;
    if (['chase', 'attack', 'grab', 'stunned', 'caughtPause'].includes(this.state)) return false;
    if (this.game.time < DETECT.graceSeconds) return false;
    radius *= this.cfg.hearing;
    const dist = Math.hypot(x - this.x, z - this.z);
    const eff = radius >= 30 || lineOfSight(this.x, this.z, x, z, this.game.dyn) ? radius : radius * 0.5;
    if (dist > eff) return false;
    const calm = this.state === 'patrol';
    this.curious = null;
    this.hideTarget = null;
    this.setState('investigate');
    const err = Math.min(2.5, dist * 0.08);
    if (!this.goTo(x + rand(-err, err), z + rand(-err, err))) this.goTo(x, z);
    this.pause = calm ? 0.7 : 0.3; // a beat of "what was that?"
    return true;
  }

  // ---- update ------------------------------------------------------------

  update(dt) {
    const game = this.game;
    this.stateTime += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.state === 'stunned') {
      this.moving = false;
      if (game.time >= this.stunUntil) { this.setState('search'); this.searchMoves = 0; this.pause = 0.5; }
      return;
    }
    if (this.state === 'grab') {
      this.moving = false;
      const p = game.players.get(this.grabbing);
      if (p) this.turnTo(Math.atan2(p.x - this.x, p.z - this.z), dt);
      return;
    }
    if (this.state === 'caughtPause') {
      this.moving = false;
      if (this.stateTime > 3) { this.setState('patrol'); this.path = null; this.room = null; }
      return;
    }

    // Eyes.
    let spotted = null, spottedSus = 0;
    if (game.time >= DETECT.graceSeconds) {
      for (const p of game.players.values()) {
        let s = this.suspicion.get(p.id) || 0;
        const visible = game.isActive(p) ? this.visibility(p) : 0;
        if (visible > 0) {
          this.recentSight.set(p.id, game.time);
          const dist = Math.hypot(p.x - this.x, p.z - this.z);
          s += visible * this.cfg.noticeRate * dt;
          if (dist < DETECT.instantDistance && (p.moving || dist < 1.4)) s = 1;
          if (this.state === 'chase' || this.state === 'search') s += dt * 1.5; // already on edge
        } else s -= DETECT.decay * dt;
        s = clamp(s, 0, 1);
        this.suspicion.set(p.id, s);
        if (visible > 0 && s > spottedSus) { spottedSus = s; spotted = p; }
      }
    }

    if (spotted && spottedSus >= 1 && this.state !== 'chase' && this.state !== 'attack') {
      this.target = spotted.id;
      this.curious = null;
      this.hideTarget = null;
      this.lostFor = 0;
      this.setState('chase');
      this.pause = 0.3; // the horrible little pause before it runs
    } else if (spotted && spottedSus >= DETECT.investigateAt && ['patrol', 'search', 'investigate'].includes(this.state)) {
      // "Was that someone?" — drift over to have a look.
      this.curiousRepath -= dt;
      if (!this.curious || this.curiousRepath <= 0) {
        this.curious = { x: spotted.x, z: spotted.z, id: spotted.id };
        this.curiousRepath = 0.8;
        if (this.state !== 'investigate') { this.setState('investigate'); this.pause = 0.6; }
        this.hideTarget = null;
        this.goTo(spotted.x, spotted.z);
      }
    }

    if (this.pause > 0) {
      this.pause -= dt;
      this.moving = false;
      if (this.curious) this.turnTo(Math.atan2(this.curious.x - this.x, this.curious.z - this.z), dt, 3);
      return;
    }

    switch (this.state) {
      case 'patrol': this.updatePatrol(dt); break;
      case 'investigate': this.updateInvestigate(dt); break;
      case 'search': this.updateSearch(dt); break;
      case 'chase': this.updateChase(dt); break;
      case 'attack': this.updateAttack(dt); break;
    }
  }

  // ---- patrol: room to room -----------------------------------------------

  pickRoom() {
    const game = this.game;
    const here = ROOMS.find(r => {
      const t = toTile(this.x, this.z);
      return t.x >= r.x0 && t.x <= r.x1 && t.z >= r.z0 && t.z <= r.z1;
    });
    const taken = new Set(game.enemies.filter(e => e !== this && e.room).map(e => e.room.name));
    const options = [];
    for (const r of ROOMS) {
      if (r === here || this.recentRooms.includes(r.name)) continue;
      let w = game.roomWeight(r.name, this);
      if (taken.has(r.name)) w *= 0.25;
      if (w > 0) options.push([r, w]);
    }
    let total = options.reduce((a, [, w]) => a + w, 0);
    let pick = Math.random() * total;
    for (const [r, w] of options) { pick -= w; if (pick <= 0) return r; }
    return options[0]?.[0] || ROOMS[0];
  }

  pointIn(room) {
    const dyn = this.game.dyn;
    for (let i = 0; i < 25; i++) {
      const x = Math.floor(rand(room.x0, room.x1 + 1)), z = Math.floor(rand(room.z0, room.z1 + 1));
      if (!FLOOR.has(MAP[z]?.[x]) || isSolidTile(x, z, dyn)) continue;
      return tileCenter({ x, z });
    }
    return null;
  }

  updatePatrol(dt) {
    if (!this.room) {
      for (let i = 0; i < 6 && !this.room; i++) {
        const r = this.pickRoom();
        const p = this.pointIn(r);
        if (p && this.goTo(p.x, p.z)) {
          this.room = r;
          this.recentRooms.push(r.name);
          if (this.recentRooms.length > 3) this.recentRooms.shift();
          this.lingerLeft = rand(...this.cfg.lingerSeconds);
          this.roomMoveIn = rand(2, 4);
        }
      }
      if (!this.room) { this.pause = 1; return; }
    }
    if (!this.arrived()) { this.followPath(dt); return; }

    // Checking a hiding place?
    if (this.hideTarget) {
      this.game.enemyChecksHide(this, this.hideTarget);
      this.hideTarget = null;
      this.pause = 1.2;
      return;
    }

    // In the room: look around, wander a little, maybe check a hiding place.
    this.moving = false;
    this.lingerLeft -= dt;
    this.yaw += dt * 1.1 * Math.sin(this.stateTime * 0.7 + this.id);
    this.roomMoveIn -= dt;
    if (this.roomMoveIn <= 0) {
      this.roomMoveIn = rand(2.5, 4.5);
      if (Math.random() < this.cfg.hideCheckChance && this.tryCheckHide(6)) return;
      const p = this.pointIn(this.room);
      if (p) this.goTo(p.x, p.z);
    }
    if (this.lingerLeft <= 0) { this.room = null; this.pause = rand(0.3, 1.2); }
  }

  tryCheckHide(range, prefer = null) {
    const near = this.game.map.hides.filter(h => {
      const c = tileCenter(h);
      return Math.hypot(c.x - this.x, c.z - this.z) < range && lineOfSight(this.x, this.z, c.x, c.z, this.game.dyn);
    });
    const h = prefer || near[Math.floor(Math.random() * near.length)];
    if (!h) return false;
    const c = tileCenter(h);
    if (!this.goTo(c.x, c.z)) return false;
    this.hideTarget = h;
    return true;
  }

  // ---- investigate / search ------------------------------------------------

  updateInvestigate(dt) {
    if (!this.arrived()) { this.followPath(dt); return; }
    this.curious = null;
    this.setState('search');
    this.searchMoves = 0;
    this.pause = rand(0.8, 1.6);
  }

  updateSearch(dt) {
    if (this.hideTarget) {
      if (!this.arrived()) { this.followPath(dt); return; }
      this.game.enemyChecksHide(this, this.hideTarget);
      this.hideTarget = null;
      this.pause = 1.2;
      return;
    }
    if (this.knownHide) {
      const h = this.knownHide; this.knownHide = null;
      if (this.tryCheckHide(30, h)) return;
    }
    if (this.stateTime > this.cfg.searchSeconds) { this.setState('patrol'); this.room = null; this.path = null; return; }
    if (!this.arrived()) { this.followPath(dt); return; }
    this.moving = false;
    this.yaw += dt * 1.8 * Math.sin(this.stateTime * 0.9 + 1);
    if (this.stateTime > 2 + (this.searchMoves || 0) * 2.5) {
      this.searchMoves = (this.searchMoves || 0) + 1;
      if (Math.random() < this.cfg.hideCheckChance + 0.2 && this.tryCheckHide(7)) return;
      this.goTo(this.x + rand(-6, 6), this.z + rand(-6, 6));
    }
  }

  // ---- chase / attack --------------------------------------------------------

  lostTarget() {
    this.target = null;
    this.room = null;
    this.setState('search');
    this.searchMoves = 0;
    if (this.lastSeen) this.goTo(this.lastSeen.x, this.lastSeen.z);
  }

  updateChase(dt) {
    const game = this.game;
    const t = game.players.get(this.target);
    if (!t) { this.lostTarget(); return; }
    if (t.hidden !== null) {
      // Saw them duck into a hiding place? It knows exactly where to look.
      if (game.time - (this.recentSight.get(t.id) ?? -99) < 1.5) this.knownHide = t.hiddenTile;
      this.lostTarget();
      return;
    }
    if (!game.isActive(t)) { this.lostTarget(); return; }

    const visible = this.visibility(t) > 0;
    if (visible) { this.lastSeen = { x: t.x, z: t.z }; this.lostFor = 0; }
    else this.lostFor += dt;
    if (this.lostFor > this.cfg.loseSightSeconds) { this.lostTarget(); return; }

    const dist = Math.hypot(t.x - this.x, t.z - this.z);
    const los = lineOfSight(this.x, this.z, t.x, t.z, game.dyn);
    if (this.cfg.attack === 'grab' && los && dist < 1.3) {
      game.grabPlayer(this, t);
      return;
    }
    if (this.cfg.attack === 'hit' && los && dist < this.cfg.hitRange && this.cooldown <= 0) {
      this.setState('attack');
      this.attackT = this.cfg.hitWindup;
      game.event('windup', { e: this.id, x: this.x, z: this.z });
      return;
    }

    const aim = visible ? t : this.lastSeen;
    if (!aim) { this.lostTarget(); return; }
    if (visible && dist < 5) {
      this.path = null;
      this.moveToward(aim.x, aim.z, dt);
    } else {
      this.repathIn -= dt;
      if (this.repathIn <= 0 || !this.path) { this.goTo(aim.x, aim.z); this.repathIn = 0.4; }
      if (!this.arrived()) this.followPath(dt);
      else this.moveToward(aim.x, aim.z, dt);
    }
  }

  updateAttack(dt) {
    const game = this.game;
    const t = game.players.get(this.target);
    if (t) {
      this.turnTo(Math.atan2(t.x - this.x, t.z - this.z), dt, 10);
      this.moveToward(t.x, t.z, dt, this.cfg.patrolSpeed * 0.5);
    }
    this.attackT -= dt;
    if (this.attackT > 0) return;
    this.cooldown = this.cfg.hitCooldown;
    const dist = t ? Math.hypot(t.x - this.x, t.z - this.z) : 99;
    if (t && game.isActive(t) && dist < this.cfg.hitRange + 0.4 && lineOfSight(this.x, this.z, t.x, t.z, game.dyn)) {
      game.hitPlayer(this, t, this.cfg.hitDamage);
      game.event('swing', { e: this.id, hit: true, x: this.x, z: this.z });
    } else game.event('swing', { e: this.id, hit: false, x: this.x, z: this.z });
    if (!t || t.downed) { this.lostTarget(); return; }
    this.setState('chase');
    this.pause = 0.7; // a breath after a swing: your chance to get away
  }

  stun(seconds = this.cfg.stunSeconds) {
    this.grabbing = null;
    this.target = null;
    this.hideTarget = null;
    this.curious = null;
    this.path = null;
    this.stunUntil = this.game.time + seconds;
    this.setState('stunned');
  }
}
