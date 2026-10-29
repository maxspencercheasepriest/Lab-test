// The Prefect: a stalker that hunts by sound and sight.
// States: patrol → investigate (heard something) → search (looks around, checks lockers)
//         chase (has seen you) → back to search when it loses you.
import { PREFECT, NOISE } from '../shared/constants.js';
import { TILE, MAP, W, toTile, tileCenter } from '../shared/map.js';
import { findPath, lineOfSight, collideCircle, tkey, isSolidTile } from '../shared/grid.js';

const rand = (a, b) => a + Math.random() * (b - a);
const angleDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class Prefect {
  constructor(game, spawnTile) {
    this.game = game;
    const c = tileCenter(spawnTile);
    this.x = c.x; this.z = c.z; this.yaw = 0;
    this.state = 'patrol';
    this.path = null; this.pathIdx = 0;
    this.target = null;          // player id when chasing
    this.lastSeen = null;        // {x,z}
    this.lostFor = 0;
    this.stateTime = 0;
    this.pause = 2;              // seconds standing still
    this.repathIn = 0;
    this.speedMul = 1;
    this.lockerTarget = null;    // locker tile being checked
    this.knownLocker = null;     // locker a player was seen entering
    this.lookYaw = 0;
    this.moving = false;
    this.recentSightOf = new Map(); // playerId -> last time seen
  }

  get speed() {
    const base = this.state === 'chase' ? PREFECT.chaseSpeed
      : this.state === 'investigate' ? PREFECT.investigateSpeed : PREFECT.patrolSpeed;
    return base * this.speedMul;
  }

  setState(s) {
    if (this.state !== s) {
      this.state = s;
      this.stateTime = 0;
      this.game.onPrefectState(s, this.target);
    }
  }

  goTo(wx, wz) {
    const from = toTile(this.x, this.z);
    const to = toTile(wx, wz);
    const dyn = this.game.dyn;
    let goal = to;
    if (isSolidTile(to.x, to.z, dyn, { doorsPassable: true })) {
      // Aim for a walkable neighbour instead (e.g. standing next to a locker).
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: to.x + dx, z: to.z + dz }))
        .filter(t => !isSolidTile(t.x, t.z, dyn, { doorsPassable: true }))
        .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
      if (!n.length) return false;
      goal = n[0];
    }
    const p = findPath(from, goal, dyn);
    if (!p) return false;
    this.path = p; this.pathIdx = 1;
    this.finalPoint = { x: wx, z: wz };
    return true;
  }

  // ---- senses ----------------------------------------------------------

  canSee(p) {
    const dx = p.x - this.x, dz = p.z - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist > PREFECT.viewDistance) return false;
    if (!lineOfSight(this.x, this.z, p.x, p.z, this.game.dyn)) return false;
    if (dist < PREFECT.peripheralDistance) return true;
    const ang = Math.atan2(dx, dz);
    if (Math.abs(angleDiff(ang, this.yaw)) > PREFECT.viewHalfAngle) return false;
    const still = !p.moving;
    if (p.crouch && still && dist > PREFECT.crouchViewDistance) return false;
    if (p.crouch && dist > PREFECT.viewDistance * 0.6) return false;
    return true;
  }

  hear(x, z, radius, sourceId) {
    if (radius <= 0) return;
    const dist = Math.hypot(x - this.x, z - this.z);
    // Very loud noises (bells) carry through the whole wing.
    const eff = radius >= 30 || lineOfSight(this.x, this.z, x, z, this.game.dyn) ? radius : radius * NOISE.throughWalls;
    if (dist > eff) return;
    if (this.state === 'chase') return;
    if (this.state === 'caughtPause') return;
    // Louder or newer noises override older investigations.
    const wasCalm = this.state === 'patrol';
    this.setState('investigate');
    this.lockerTarget = null;
    // Slight inaccuracy: it heard roughly where you were.
    const err = Math.min(2.5, dist * 0.08);
    const tx = x + rand(-err, err), tz = z + rand(-err, err);
    if (!this.goTo(tx, tz)) this.goTo(x, z);
    this.pause = wasCalm ? 0.6 : 0.25; // a beat of "what was that"
  }

  // ---- update ----------------------------------------------------------

  update(dt) {
    const game = this.game;
    this.stateTime += dt;

    // Look for players.
    let spotted = null, best = Infinity;
    for (const p of game.activePlayers()) {
      if (this.canSee(p)) {
        this.recentSightOf.set(p.id, game.time);
        const d = Math.hypot(p.x - this.x, p.z - this.z);
        if (d < best) { best = d; spotted = p; }
      }
    }

    if (this.state === 'caughtPause') {
      this.moving = false;
      if (this.stateTime > 3) this.setState('patrol');
      return;
    }

    if (spotted && this.state !== 'chase') {
      this.target = spotted.id;
      this.setState('chase');
      this.pause = 0.35; // the horrible little pause before it runs
    }

    if (this.pause > 0) { this.pause -= dt; this.moving = false; return; }

    switch (this.state) {
      case 'patrol': this.updatePatrol(dt); break;
      case 'investigate': this.updateInvestigate(dt); break;
      case 'search': this.updateSearch(dt); break;
      case 'chase': this.updateChase(dt, spotted); break;
    }
  }

  updatePatrol(dt) {
    if (!this.path || this.pathIdx >= this.path.length) {
      // Pick somewhere new. Sometimes drift towards where the children are.
      const players = this.game.activePlayers();
      let ok = false;
      if (players.length && Math.random() < 0.4) {
        const p = players[Math.floor(Math.random() * players.length)];
        ok = this.goTo(p.x + rand(-8, 8), p.z + rand(-8, 8));
      }
      for (let i = 0; i < 5 && !ok; i++) {
        const t = this.game.patrolTiles[Math.floor(Math.random() * this.game.patrolTiles.length)];
        const c = tileCenter(t);
        if (Math.hypot(c.x - this.x, c.z - this.z) > 8) ok = this.goTo(c.x, c.z);
      }
      this.pause = rand(0.5, 2.5);
      return;
    }
    this.followPath(dt);
  }

  updateInvestigate(dt) {
    if (!this.path || this.pathIdx >= this.path.length) {
      this.setState('search');
      this.lookYaw = this.yaw;
      this.searchMoves = 0;
      this.pause = rand(0.8, 1.6);
      return;
    }
    this.followPath(dt);
  }

  updateSearch(dt) {
    // Walking to a locker to check it?
    if (this.lockerTarget) {
      if (this.path && this.pathIdx < this.path.length) { this.followPath(dt); return; }
      this.game.prefectOpensLocker(this.lockerTarget);
      this.lockerTarget = null;
      this.pause = 1.2;
      return;
    }
    if (this.knownLocker) {
      const lt = this.knownLocker; this.knownLocker = null;
      const c = tileCenter(lt);
      if (this.goTo(c.x, c.z)) { this.lockerTarget = lt; return; }
    }
    if (this.stateTime > PREFECT.searchSeconds) { this.setState('patrol'); this.path = null; return; }
    if (this.path && this.pathIdx < this.path.length) { this.followPath(dt); return; }

    // Look around, then poke about nearby — and maybe check a locker.
    this.moving = false;
    this.yaw += dt * 1.6 * Math.sin(this.stateTime * 0.9 + 1);
    if (this.stateTime > 2 + this.searchMoves * 2.5) {
      this.searchMoves++;
      const lockers = this.game.map.lockers.filter(l => {
        const c = tileCenter(l);
        return Math.hypot(c.x - this.x, c.z - this.z) < 7 && lineOfSight(this.x, this.z, c.x, c.z, this.game.dyn);
      });
      if (lockers.length && Math.random() < this.game.lockerCheckChance()) {
        const lt = lockers[Math.floor(Math.random() * lockers.length)];
        const c = tileCenter(lt);
        if (this.goTo(c.x, c.z)) { this.lockerTarget = lt; return; }
      }
      this.goTo(this.x + rand(-6, 6), this.z + rand(-6, 6));
    }
  }

  updateChase(dt, spotted) {
    const game = this.game;
    const t = game.players.get(this.target);
    // Target hid in a locker in front of it?
    if (t && t.hidden !== null) {
      const seenAt = this.recentSightOf.get(t.id) ?? -99;
      if (game.time - seenAt < 1.5) this.knownLocker = { x: t.hidden % W, z: Math.floor(t.hidden / W) };
      this.lostTarget();
      return;
    }
    if (!t || !game.isActive(t)) {
      // Switch to someone else visible, else search.
      if (spotted) { this.target = spotted.id; } else { this.lostTarget(); return; }
    }
    const tgt = game.players.get(this.target);
    const visible = this.canSee(tgt);
    if (visible) { this.lastSeen = { x: tgt.x, z: tgt.z }; this.lostFor = 0; }
    else this.lostFor += dt;

    if (this.lostFor > PREFECT.loseSightSeconds) { this.lostTarget(); return; }

    const dist = Math.hypot(tgt.x - this.x, tgt.z - this.z);
    if (visible && dist < PREFECT.catchDistance) {
      game.catchPlayer(tgt);
      this.target = null;
      this.path = null;
      this.setState('caughtPause');
      return;
    }

    const aim = visible ? tgt : this.lastSeen;
    if (!aim) { this.lostTarget(); return; }
    if (visible && dist < 5) {
      this.path = null;
      this.moveToward(aim.x, aim.z, dt);
    } else {
      this.repathIn -= dt;
      if (this.repathIn <= 0 || !this.path) { this.goTo(aim.x, aim.z); this.repathIn = 0.4; }
      if (this.path && this.pathIdx < this.path.length) this.followPath(dt);
      else this.moveToward(aim.x, aim.z, dt);
    }
  }

  lostTarget() {
    this.target = null;
    this.setState('search');
    this.searchMoves = 0;
    if (this.lastSeen) this.goTo(this.lastSeen.x, this.lastSeen.z);
  }

  // ---- movement --------------------------------------------------------

  followPath(dt) {
    const wp = this.path[this.pathIdx];
    const last = this.pathIdx === this.path.length - 1;
    // Open any closed door we're about to walk into.
    if (MAP[wp.z][wp.x] === 'D' && !this.game.dyn.doors.get(tkey(wp.x, wp.z))) {
      const c = tileCenter(wp);
      if (Math.hypot(c.x - this.x, c.z - this.z) < TILE * 1.2) {
        this.game.setDoor(wp, true, 'prefect');
        this.pause = this.state === 'chase' ? 0.15 : 0.5;
        return;
      }
    }
    let c = tileCenter(wp);
    if (last && this.finalPoint) {
      const ft = toTile(this.finalPoint.x, this.finalPoint.z);
      if (!isSolidTile(ft.x, ft.z, this.game.dyn, { doorsPassable: true })) c = this.finalPoint;
    }
    const d = Math.hypot(c.x - this.x, c.z - this.z);
    if (d < 0.25) { this.pathIdx++; return; }
    this.moveToward(c.x, c.z, dt);
  }

  moveToward(x, z, dt) {
    const dx = x - this.x, dz = z - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.01) { this.moving = false; return; }
    const step = Math.min(d, this.speed * dt);
    const nx = this.x + (dx / d) * step, nz = this.z + (dz / d) * step;
    const p = collideCircle(nx, nz, PREFECT.radius, this.game.dyn, { doorsPassable: false });
    const moved = Math.hypot(p.x - this.x, p.z - this.z);
    this.x = p.x; this.z = p.z;
    this.moving = moved > 0.001;
    const want = Math.atan2(dx, dz);
    this.yaw += angleDiff(want, this.yaw) * Math.min(1, dt * 8);
  }
}
