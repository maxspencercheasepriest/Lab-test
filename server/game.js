// One running Lesson: the authoritative simulation for a room.
import { TICK_HZ, PLAYER, NOISE, NV, LESSON, GRAB, DETECT } from '../shared/constants.js';
import { parseMap, tileCenter, toTile, TILE, MAP, W, ROOMS, roomAt } from '../shared/map.js';
import { tkey, collideCircle, isSolidTile, lineOfSight, findPath } from '../shared/grid.js';
import { pickLine } from '../shared/tannoy.js';
import { Enemy } from './enemy.js';

const near = (a, b, r) => Math.hypot(a.x - b.x, a.z - b.z) <= r;
// Props that fill a whole tile are reachable from the edge of the tile, not the centre.
const PROP_REACH = PLAYER.interactRange + TILE / 2 + 0.4;
const ADJ = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export class Lesson {
  constructor(room, opts = {}) {
    this.room = room;               // { players, broadcast(msg), send(id,msg), endLesson() }
    this.map = parseMap();
    this.time = 0;
    this.over = false;
    this.dyn = { doors: new Map(), gateOpen: false, exitOpen: false };
    for (const d of this.map.doors) this.dyn.doors.set(tkey(d.x, d.z), false);
    this.doorSlamAt = new Map();

    this.bells = this.map.bells.map(() => false);
    this.items = [];
    this.placeItems();
    this.reelsDelivered = 0;
    this.keyTaken = false;
    this.plateReleasedAt = -99;
    this.plateHumIn = 0;
    this.plateAnnounced = false;
    this.lever = { holder: null, since: 0 };
    this.lightsOutUntil = 0;
    this.lightsBack = false;
    this.idleIn = 60;
    this.pendingNoises = [];
    this.lastChaseLine = -99;
    this.graceAnnounced = false;

    this.players = new Map();
    const spawns = this.map.spawns;
    let i = 0;
    for (const p of room.players.values()) {
      const s = tileCenter(spawns[i++ % spawns.length]);
      this.players.set(p.id, {
        id: p.id, name: p.name,
        x: s.x, z: s.z, yaw: Math.PI, pitch: 0,
        crouch: false, moving: false, running: false, radio: false, nv: true,
        battery: 1, hidden: null, hiddenTile: null, caught: null, escaped: false,
        carrying: null, throwable: null, syringes: 0, holding: null,
        hp: PLAYER.maxHealth, lastHurt: -99, downed: false, downedAt: 0,
        grabbed: null, grabs: 0, healUntil: 0, glassCd: 0,
        revive: null, // { target, since }
      });
    }

    let eid = 0;
    this.enemies = [new Enemy(this, eid++, 'prefect', this.map.prefect)];
    for (const o of this.map.orderlies) this.enemies.push(new Enemy(this, eid++, 'orderly', o));
    this.nextEnemyId = eid;
    if (opts.noEnemies) this.enemies = [];

    this.room.broadcast({ t: 'start', players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, x: p.x, z: p.z })) });
    this.say('start');
    this.later(9, () => this.say('tasks'));
    if (!opts.manual) this.interval = setInterval(() => this.tick(1 / TICK_HZ), 1000 / TICK_HZ);
  }

  stop() { clearInterval(this.interval); }

  // ---- setup -------------------------------------------------------------

  placeItems() {
    let id = 0;
    const add = (kind, t) => this.items.push({ id: id++, kind, ...tileCenter(t), carrier: null, gone: false });
    const proj = tileCenter(this.map.projector);
    const spots = shuffle([...this.map.spots]);
    // Three reels, far from the projector and in different rooms.
    const usedRooms = new Set();
    const reels = [];
    for (const s of spots) {
      const c = tileCenter(s);
      const r = roomAt(s.x, s.z)?.name;
      if (Math.hypot(c.x - proj.x, c.z - proj.z) < 14 || usedRooms.has(r) || r === 'Study') continue;
      reels.push(s); usedRooms.add(r);
      if (reels.length === 3) break;
    }
    for (const s of reels) add('reel', s);
    const rest = spots.filter(s => !reels.includes(s));
    const kinds = ['bottle', 'syringe', 'battery', 'brick', 'bottle', 'syringe', 'brick', 'battery', 'bottle', 'brick', 'syringe', 'bottle', 'battery'];
    rest.forEach((s, i) => add(kinds[i % kinds.length], s));
    // A few extra throwables lying in the corridors.
    const floor = [];
    for (let z = 9; z <= 11; z++) for (let x = 1; x < W - 1; x++) if (MAP[z][x] === '.') floor.push({ x, z });
    for (const t of shuffle(floor).slice(0, 4)) add(Math.random() < 0.5 ? 'bottle' : 'brick', t);
    add('key', this.map.key);
  }

  // ---- helpers ---------------------------------------------------------

  // Can enemies see / chase this player?
  isActive(p) { return p && p.caught === null && !p.escaped && p.hidden === null && !p.downed && !p.grabbed; }
  // Still in the game (could finish the Lesson)?
  isFree(p) { return p && p.caught === null && !p.escaped && !p.downed; }
  activePlayers() { return [...this.players.values()].filter(p => this.isActive(p)); }
  get lightsOut() { return this.time < this.lightsOutUntil; }
  get prefect() { return this.enemies.find(e => e.kind === 'prefect'); }

  later(seconds, fn) { this.pendingNoises.push({ at: this.time + seconds, fn }); }

  say(cat, name) {
    const line = pickLine(cat, name);
    if (line) this.room.broadcast({ t: 'tannoy', cat, line });
  }
  event(e, data = {}) { this.room.broadcast({ t: 'ev', e, ...data }); }

  noise(x, z, radius) {
    for (const e of this.enemies) e.hear(x, z, radius);
  }

  // How much each enemy wants to patrol a room — escalates as the Lesson goes on.
  roomWeight(name) {
    if (name === 'Study' && !this.dyn.gateOpen) return 0;
    let w = 1;
    if (name.startsWith('Corridor')) w = 1.4;
    if (this.keyTaken && (name === 'Entrance Hall' || name === 'Boiler Room' || name === 'Infirmary')) w *= 2.5;
    if (this.dyn.exitOpen && name === 'Entrance Hall') w *= 3;
    if (name === 'Correction' && [...this.players.values()].some(p => p.caught !== null)) w *= 2; // guarding the cages
    return w;
  }

  setDoor(tile, open, by) {
    const k = tkey(tile.x, tile.z);
    if (this.dyn.doors.get(k) === open) return;
    this.dyn.doors.set(k, open);
    const c = tileCenter(tile);
    this.event('door', { x: tile.x, z: tile.z, open, by: by === 'enemy' ? 'enemy' : 'player' });
    if (by !== 'enemy') this.noise(c.x, c.z, NOISE.door);
  }

  onEnemyState(enemy, s) {
    this.event('enemy', { id: enemy.id, s });
    if (s === 'chase' && this.time - this.lastChaseLine > 30) {
      this.lastChaseLine = this.time;
      const t = this.players.get(enemy.target);
      this.later(1.2, () => this.say('chase', t?.name || ''));
    }
  }

  // ---- player input ----------------------------------------------------

  onState(id, m) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    p.yaw = +m.yaw || 0; p.pitch = +m.pitch || 0;
    p.radio = !!m.radio; p.nv = !!m.nv;
    if (p.caught !== null || p.hidden !== null || p.escaped || p.grabbed) return;
    if (p.holding === 'plate' || p.holding === 'lever' || this.time < p.healUntil) { p.moving = false; return; }
    const nx = +m.x, nz = +m.z;
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
    if (!process.env.DEV && Math.hypot(nx - p.x, nz - p.z) > 4) {
      this.room.send(id, { t: 'correct', x: p.x, z: p.z });
      return;
    }
    const c = collideCircle(nx, nz, PLAYER.radius * 0.8, this.dyn);
    const moved = Math.hypot(c.x - p.x, c.z - p.z);
    p.x = c.x; p.z = c.z;
    p.crouch = !!m.crouch || p.downed; p.moving = !!m.moving; p.running = !!m.running && !p.downed;
    if (p.holding === 'revive' && moved > 0.3) this.stopRevive(p);
    // Broken glass crunches underfoot unless you crouch.
    const t = toTile(p.x, p.z);
    p.glassCd -= 1 / TICK_HZ;
    if (MAP[t.z]?.[t.x] === 'g' && p.moving && !p.crouch && p.glassCd <= 0) {
      p.glassCd = 0.45;
      this.event('glass', { x: p.x, z: p.z });
      this.noise(p.x, p.z, NOISE.glass);
    }
  }

  onNoise(id, m) {
    const p = this.players.get(id);
    if (!p || p.caught !== null || p.escaped) return;
    let r = 0;
    const lvl = Math.max(0, Math.min(1, +m.level || 0));
    switch (m.kind) {
      case 'walk': r = p.crouch ? NOISE.crouch : NOISE.walk; break;
      case 'run': r = NOISE.run; break;
      case 'talk': r = lvl < 0.45 ? NOISE.talk : NOISE.talk + (NOISE.shout - NOISE.talk) * (lvl - 0.45) / 0.55; break;
      case 'radio': r = NOISE.radio; break;
    }
    if (p.hidden !== null) r *= 0.5;
    if ((m.kind === 'walk' || m.kind === 'run') && !this.isActive(p)) return;
    this.noise(p.x, p.z, r);
  }

  onAct(id, m) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    const a = m.a;

    if (a === 'hide') {
      if (p.hidden !== null) return this.leaveHide(p);
      if (!this.isActive(p) || p.holding) return;
      const h = this.map.hides.find(t => t.x === m.x && t.z === m.z);
      if (!h || !near(p, tileCenter(h), PROP_REACH)) return;
      const k = tkey(h.x, h.z);
      if ([...this.players.values()].some(o => o.hidden === k)) return this.room.send(id, { t: 'toast', text: 'Someone is already in there.' });
      p.hidden = k; p.hiddenTile = h;
      p.hideFrom = { x: p.x, z: p.z };
      const c = tileCenter(h);
      this.event('hide', { x: c.x, z: c.z, id, kind: h.kind, open: true });
      if (h.kind === 'locker') this.noise(c.x, c.z, NOISE.locker * (p.running ? 1.6 : 1));
      return;
    }
    if (a === 'heal') {
      if (!this.isActive(p) || p.syringes <= 0 || p.hp >= PLAYER.maxHealth || this.time < p.healUntil) return;
      p.healUntil = this.time + PLAYER.syringeSeconds;
      this.event('heal', { id });
      return;
    }
    if (!this.isActive(p)) return;

    if (a === 'door') {
      const d = this.map.doors.find(t => t.x === m.x && t.z === m.z);
      if (!d || !near(p, tileCenter(d), PLAYER.interactRange + 0.8)) return;
      const k = tkey(d.x, d.z);
      const open = !this.dyn.doors.get(k);
      if (!open) {
        if (this.playerInDoorway(d)) return;
        const e = this.enemyInDoorway(d);
        if (e) {
          // Slam it in their face.
          if (this.time - (this.doorSlamAt.get(k) || -99) < 4 || e.state === 'grab') return;
          this.doorSlamAt.set(k, this.time);
          const c = tileCenter(d);
          const dx = e.x - p.x, dz = e.z - p.z, dl = Math.hypot(dx, dz) || 1;
          const pushed = collideCircle(c.x + (dx / dl) * TILE * 0.9, c.z + (dz / dl) * TILE * 0.9, e.cfg.radius, this.dyn);
          e.x = pushed.x; e.z = pushed.z;
          e.stun(e.cfg.stunSeconds * 0.8);
          this.dyn.doors.set(k, false);
          this.event('slam', { x: d.x, z: d.z, e: e.id });
          this.noise(c.x, c.z, NOISE.slam);
          if (Math.random() < 0.5) this.later(1, () => this.say('stunned'));
          return;
        }
      }
      this.setDoor(d, open, id);
      return;
    }
    if (a === 'bell') {
      const i = this.map.bells.findIndex(t => t.x === m.x && t.z === m.z);
      if (i < 0 || this.bells[i] || !near(p, tileCenter(this.map.bells[i]), PROP_REACH)) return;
      this.bells[i] = true;
      const c = tileCenter(this.map.bells[i]);
      this.event('bell', { x: c.x, z: c.z, i });
      this.noise(c.x, c.z, NOISE.bell);
      if (this.bells.every(Boolean)) {
        this.later(2.5, () => {
          this.say('bellsDone');
          this.later(5.5, () => {
            this.lightsOutUntil = this.time + LESSON.lightsOutSeconds;
            for (const e of this.enemies) e.speedMul = 1.12;
            this.event('lights', { on: false });
          });
        });
      } else this.later(1.8, () => this.say('bell', p.name));
      return;
    }
    if (a === 'pickup') {
      const it = this.items.find(i => i.id === m.item);
      if (!it || it.gone || it.carrier !== null || !near(p, it, PLAYER.interactRange + 0.3)) return;
      switch (it.kind) {
        case 'battery':
          it.gone = true;
          p.battery = Math.min(1, p.battery + NV.batteryPickup);
          this.room.send(id, { t: 'toast', text: 'Fresh battery in the goggles.' });
          return;
        case 'syringe':
          if (p.syringes >= PLAYER.maxSyringes) return this.room.send(id, { t: 'toast', text: `You can only carry ${PLAYER.maxSyringes} syringes.` });
          it.gone = true; p.syringes++;
          return;
        case 'bottle': case 'brick':
          if (p.throwable !== null) return this.room.send(id, { t: 'toast', text: 'You already have something to throw.' });
          it.carrier = id; p.throwable = it.id;
          return;
        default:
          if (p.carrying !== null) return this.room.send(id, { t: 'toast', text: 'Your hands are full. [G] to drop.' });
          it.carrier = id; p.carrying = it.id;
          if (it.kind === 'key' && !this.keyTaken) {
            this.keyTaken = true;
            if (this.prefect) this.prefect.speedMul = Math.max(this.prefect.speedMul, 1.08);
            this.say('key', p.name);
            this.event('phase', { p: 'key' });
          }
          return;
      }
    }
    if (a === 'drop') return this.dropCarried(p);
    if (a === 'projector') {
      const it = this.items.find(i => i.id === p.carrying);
      if (!it || it.kind !== 'reel' || !near(p, tileCenter(this.map.projector), PROP_REACH)) return;
      it.gone = true; it.carrier = null; p.carrying = null;
      this.reelsDelivered++;
      this.event('projector', { n: this.reelsDelivered });
      this.noise(p.x, p.z, 7);
      const done = this.reelsDelivered === 3;
      this.say(done ? 'reelsDone' : 'reel', p.name);
      if (done) this.later(6, () => this.releaseOrderly());
      return;
    }
    if (a === 'exit') {
      const ex = this.map.exits.map(tileCenter);
      if (!ex.some(c => near(p, c, PROP_REACH))) return;
      if (this.dyn.exitOpen) {
        p.escaped = true;
        this.dropCarried(p);
        this.event('escaped', { id });
        this.say('escaped', p.name);
        this.checkEnd();
        return;
      }
      const it = this.items.find(i => i.id === p.carrying);
      const needs = [];
      if (!this.bells.every(Boolean)) needs.push('the bells');
      if (this.reelsDelivered < 3) needs.push('the reels');
      if (!it || it.kind !== 'key') needs.push('the study key');
      if (needs.length) return this.room.send(id, { t: 'toast', text: `Locked. Still to do: ${needs.join(', ')}.` });
      it.gone = true; it.carrier = null; p.carrying = null;
      this.dyn.exitOpen = true;
      for (const e of this.enemies) { e.speedMul = Math.max(e.speedMul, 1.1); e.room = null; }
      this.event('exit', {});
      this.noise(p.x, p.z, 25);
      this.say('exitOpen');
      return;
    }
  }

  onHold(id, m) {
    const p = this.players.get(id);
    if (!p) return;
    if (!m.on) {
      if (p.holding === 'plate') this.plateReleasedAt = this.time;
      if (p.holding === 'lever' && this.lever.holder === id) this.lever.holder = null;
      if (p.holding === 'revive') this.stopRevive(p);
      p.holding = null;
      return;
    }
    if (!this.isActive(p)) return;
    if (m.a === 'plate' && near(p, tileCenter(this.map.plate), 1.4)) {
      p.holding = 'plate';
      if (!this.plateAnnounced) { this.plateAnnounced = true; this.say('plate'); }
    } else if (m.a === 'lever' && near(p, tileCenter(this.map.lever), PROP_REACH)) {
      if (this.lever.holder && this.lever.holder !== id) return;
      p.holding = 'lever';
      this.lever = { holder: id, since: this.time };
      this.event('lever', { on: true });
    } else if (m.a === 'revive') {
      const t = this.players.get(m.target);
      if (!t || !t.downed || !near(p, t, 2.2)) return;
      if ([...this.players.values()].some(o => o !== p && o.revive?.target === t.id)) return;
      p.holding = 'revive';
      p.revive = { target: t.id, since: this.time };
    }
  }

  onStruggle(id) {
    const p = this.players.get(id);
    if (!p?.grabbed) return;
    const g = p.grabbed;
    if (this.time - g.lastPress < 1 / 16) return; // no autoclickers
    g.lastPress = this.time;
    g.progress += GRAB.perPress / (1 + GRAB.harderPerGrab * (p.grabs - 1));
    if (Math.random() < 0.25) this.noise(p.x, p.z, NOISE.struggle);
    if (g.progress >= 1) this.releaseGrab(p, true);
  }

  onThrow(id, m) {
    const p = this.players.get(id);
    if (!this.isActive(p) || p.throwable === null) return;
    const it = this.items.find(i => i.id === p.throwable);
    p.throwable = null;
    it.gone = true; it.carrier = null;
    let tx = +m.x, tz = +m.z;
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
    let d = Math.hypot(tx - p.x, tz - p.z);
    if (d > 18) { tx = p.x + (tx - p.x) / d * 18; tz = p.z + (tz - p.z) / d * 18; d = 18; }
    // Did it hit somebody on the way?
    let hitEnemy = null, best = Infinity;
    for (const e of this.enemies) {
      const ex = e.x - p.x, ez = e.z - p.z;
      const along = (ex * (tx - p.x) + ez * (tz - p.z)) / (d || 1);
      if (along < 0 || along > d + 0.8) continue;
      const perp = Math.abs(ex * (tz - p.z) - ez * (tx - p.x)) / (d || 1);
      if (perp < 1.0 && along < best && lineOfSight(p.x, p.z, e.x, e.z, this.dyn)) { best = along; hitEnemy = e; }
    }
    if (hitEnemy) { tx = hitEnemy.x; tz = hitEnemy.z; d = best; }
    const delay = 0.2 + Math.min(d, 18) / 16;
    this.event('throw', { id, k: it.kind, x: p.x, z: p.z, tx, tz, delay });
    this.pendingNoises.push({ at: this.time + delay, fn: () => {
      if (hitEnemy) {
        const victim = hitEnemy.grabbing !== null ? this.players.get(hitEnemy.grabbing) : null;
        hitEnemy.stun();
        if (victim?.grabbed) this.releaseGrab(victim, false);
        this.event('stun', { e: hitEnemy.id, x: tx, z: tz, k: it.kind });
        if (Math.random() < 0.4) this.later(1, () => this.say('stunned'));
      }
      this.event('smash', { x: tx, z: tz, k: it.kind });
      this.noise(tx, tz, NOISE.bottle);
    } });
  }

  // ---- state changes ---------------------------------------------------

  dropCarried(p) {
    for (const key of ['carrying', 'throwable']) {
      const it = this.items.find(i => i.id === p[key]);
      if (it) { it.carrier = null; it.x = p.x; it.z = p.z; }
      p[key] = null;
    }
  }

  inDoorway(tile, o) {
    const c = tileCenter(tile);
    return Math.abs(o.x - c.x) < TILE / 2 + 0.3 && Math.abs(o.z - c.z) < TILE / 2 + 0.3;
  }
  playerInDoorway(tile) {
    return [...this.players.values()].some(p => p.caught === null && !p.escaped && p.hidden === null && this.inDoorway(tile, p));
  }
  enemyInDoorway(tile) { return this.enemies.find(e => this.inDoorway(tile, e)) || null; }

  leaveHide(p) {
    const h = p.hiddenTile;
    p.hidden = null; p.hiddenTile = null;
    const opts = ADJ.map(([dx, dz]) => ({ x: h.x + dx, z: h.z + dz })).filter(t => !isSolidTile(t.x, t.z, this.dyn));
    const from = p.hideFrom || tileCenter(h);
    opts.sort((a, b) => Math.hypot(tileCenter(a).x - from.x, tileCenter(a).z - from.z) - Math.hypot(tileCenter(b).x - from.x, tileCenter(b).z - from.z));
    const out = opts[0] ? tileCenter(opts[0]) : from;
    const lc = tileCenter(h);
    p.x = lc.x + (out.x - lc.x) * 0.62; p.z = lc.z + (out.z - lc.z) * 0.62;
    this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    this.event('hide', { x: lc.x, z: lc.z, id: p.id, kind: h.kind, open: false });
    if (h.kind === 'locker') this.noise(lc.x, lc.z, NOISE.locker);
  }

  enemyChecksHide(enemy, h) {
    const k = tkey(h.x, h.z);
    const c = tileCenter(h);
    this.event('hideCheck', { x: c.x, z: c.z, kind: h.kind, e: enemy.id });
    const p = [...this.players.values()].find(o => o.hidden === k);
    if (!p) return;
    if (enemy.kind === 'prefect') {
      p.hidden = null; p.hiddenTile = null;
      p.x = enemy.x; p.z = enemy.z;
      this.catchPlayer(p, enemy);
    } else {
      // Dragged out and beaten.
      this.leaveHide(p);
      this.hitPlayer(enemy, p, enemy.cfg.hitDamage);
      enemy.target = p.id;
      enemy.lastSeen = { x: p.x, z: p.z };
      enemy.setState('chase');
      enemy.pause = 0.8;
    }
  }

  hitPlayer(enemy, p, dmg) {
    if (p.downed || p.caught !== null) return;
    p.hp -= dmg;
    p.lastHurt = this.time;
    p.healUntil = 0;
    if (p.holding) this.onHold(p.id, { on: false });
    this.event('hit', { id: p.id, x: p.x, z: p.z, dmg });
    // Knocked back a little.
    const dx = p.x - enemy.x, dz = p.z - enemy.z, d = Math.hypot(dx, dz) || 1;
    const k = collideCircle(p.x + dx / d * 0.9, p.z + dz / d * 0.9, PLAYER.radius, this.dyn);
    p.x = k.x; p.z = k.z;
    this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    if (p.hp <= 0) this.downPlayer(p);
  }

  downPlayer(p) {
    p.hp = 0;
    p.downed = true;
    p.downedAt = this.time;
    p.holding = null;
    this.dropCarried(p);
    for (const e of this.enemies) if (e.target === p.id) e.lostTarget();
    this.event('downed', { id: p.id, x: p.x, z: p.z });
    this.later(1.5, () => this.say('downed', p.name));
    this.checkEnd();
  }

  stopRevive(p) {
    p.holding = p.holding === 'revive' ? null : p.holding;
    p.revive = null;
  }

  grabPlayer(enemy, p) {
    if (p.grabbed || !this.isActive(p)) return;
    p.grabs++;
    if (p.holding) this.onHold(p.id, { on: false });
    p.healUntil = 0;
    p.grabbed = { by: enemy.id, progress: 0, until: this.time + GRAB.seconds, lastPress: -1 };
    enemy.grabbing = p.id;
    enemy.target = p.id;
    enemy.setState('grab');
    this.event('grab', { id: p.id, e: enemy.id, x: p.x, z: p.z });
    this.later(0.6, () => this.say('grab', p.name));
  }

  releaseGrab(p, struggled) {
    const enemy = this.enemies.find(e => e.id === p.grabbed?.by);
    p.grabbed = null;
    if (enemy) {
      if (enemy.state === 'grab') enemy.stun();
      const dx = p.x - enemy.x, dz = p.z - enemy.z, d = Math.hypot(dx, dz) || 1;
      const k = collideCircle(p.x + dx / d * 1.4, p.z + dz / d * 1.4, PLAYER.radius, this.dyn);
      p.x = k.x; p.z = k.z;
    }
    if (struggled) {
      p.hp = Math.max(1, p.hp - GRAB.escapeDamage);
      p.lastHurt = this.time;
      this.say('escapeGrab', p.name);
    }
    this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    this.event('released', { id: p.id, struggled });
  }

  catchPlayer(p, enemy = null) {
    if (p.caught !== null) return;
    this.dropCarried(p);
    if (p.holding === 'plate') this.plateReleasedAt = this.time;
    p.holding = null; p.revive = null;
    p.grabbed = null;
    p.downed = false;
    p.hp = Math.max(p.hp, 50);
    p.healUntil = 0;
    for (const e of this.enemies) {
      if (e.grabbing === p.id) e.grabbing = null;
      if (e.target === p.id) { e.target = null; e.setState('caughtPause'); }
    }
    if (enemy && enemy.state !== 'caughtPause') enemy.setState('caughtPause');
    const used = new Set([...this.players.values()].map(o => o.caught).filter(c => c !== null));
    let cage = 0;
    while (used.has(cage)) cage++;
    p.caught = cage;
    const c = tileCenter(this.map.cages[cage % this.map.cages.length]);
    this.event('caught', { id: p.id, x: p.x, z: p.z });
    p.x = c.x + (cage >= this.map.cages.length ? 0.4 : 0); p.z = c.z;
    this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    this.later(1.5, () => this.say('caught', p.name));
    this.checkEnd();
  }

  freeAll() {
    const caged = [...this.players.values()].filter(p => p.caught !== null && !p.escaped);
    if (!caged.length) return;
    const lv = tileCenter(this.map.lever);
    for (const p of caged) {
      p.caught = null;
      const spot = collideCircle(lv.x - 2 - Math.random() * 3, lv.z - 1.5 - Math.random() * 2, PLAYER.radius, this.dyn);
      p.x = spot.x; p.z = spot.z;
      this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    }
    this.event('freed', { ids: caged.map(p => p.id) });
    this.noise(lv.x, lv.z, 12);
    this.say('freed');
  }

  releaseOrderly() {
    // Let another one out, somewhere none of you are.
    const players = [...this.players.values()].filter(p => p.caught === null && !p.escaped);
    const rooms = ROOMS.filter(r => r.name !== 'Study' && r.name !== 'Correction');
    rooms.sort((a, b) => {
      const da = Math.min(...players.map(p => Math.hypot((a.x0 + a.x1) / 2 * TILE - p.x, (a.z0 + a.z1) / 2 * TILE - p.z)), 999);
      const db = Math.min(...players.map(p => Math.hypot((b.x0 + b.x1) / 2 * TILE - p.x, (b.z0 + b.z1) / 2 * TILE - p.z)), 999);
      return db - da;
    });
    for (const r of rooms) {
      const e = new Enemy(this, this.nextEnemyId, 'orderly', { x: r.x0, z: r.z0 });
      const pt = e.pointIn(r);
      if (!pt) continue;
      e.x = pt.x; e.z = pt.z;
      this.nextEnemyId++;
      this.enemies.push(e);
      this.event('released', { e: e.id, newEnemy: true });
      return;
    }
  }

  checkEnd() {
    if (this.over) return;
    const all = [...this.players.values()];
    if (!all.length) return;
    if (all.some(p => this.isFree(p))) return;
    this.over = true;
    const escaped = all.filter(p => p.escaped);
    const win = escaped.length > 0;
    this.later(win ? 0.5 : 3, () => {
      this.say(win ? 'win' : 'fail');
      this.event('end', { win, escaped: escaped.map(p => p.name), kept: all.filter(p => !p.escaped).map(p => p.name), time: Math.round(this.time) });
      this.later(1, () => this.room.endLesson());
    });
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.dropCarried(p);
    if (p.grabbed) this.releaseGrab(p, false);
    for (const o of this.players.values()) if (o.revive?.target === id) this.stopRevive(o);
    this.players.delete(id);
    for (const e of this.enemies) if (e.target === id || e.grabbing === id) e.lostTarget();
    this.checkEnd();
  }

  // ---- tick ------------------------------------------------------------

  tick(dt) {
    this.time += dt;

    // Scheduled things (thrown objects landing, tannoy lines...).
    const due = this.pendingNoises.filter(n => n.at <= this.time);
    this.pendingNoises = this.pendingNoises.filter(n => n.at > this.time);
    for (const n of due) n.fn();
    if (!this.graceAnnounced && this.time > DETECT.graceSeconds) { this.graceAnnounced = true; this.event('hunt', {}); }

    // Pressure plate and gate.
    const plate = tileCenter(this.map.plate);
    const onPlate = [...this.players.values()].filter(p => p.holding === 'plate' && this.isActive(p) && near(p, plate, 1.6));
    const solo = this.players.size === 1;
    const wasOpen = this.dyn.gateOpen;
    let open = onPlate.length > 0 || this.time - this.plateReleasedAt < (solo ? LESSON.plateGraceSolo : LESSON.plateGraceSeconds);
    if (!open && wasOpen && this.map.gates.some(g => this.playerInDoorway(g) || this.enemyInDoorway(g))) open = true;
    this.dyn.gateOpen = open;
    if (open !== wasOpen) this.event('gate', { open });
    if (onPlate.length) {
      this.plateHumIn -= dt;
      if (this.plateHumIn <= 0) { this.plateHumIn = 1; this.noise(plate.x, plate.z, NOISE.plateHum); }
    }

    // Lever.
    if (this.lever.holder) {
      const h = this.players.get(this.lever.holder);
      if (!h || h.holding !== 'lever' || !this.isActive(h)) this.lever.holder = null;
      else if (this.time - this.lever.since >= LESSON.leverHoldSeconds) {
        h.holding = null; this.lever.holder = null;
        this.room.send(h.id, { t: 'holdDone' });
        this.freeAll();
      }
    }

    for (const p of this.players.values()) {
      // Night-vision batteries.
      if (p.nv && p.caught === null && !p.escaped) p.battery = Math.max(0, p.battery - NV.drainPerSecond * dt);
      // Carried items follow you.
      if (p.carrying !== null || p.throwable !== null) for (const it of this.items) if (it.carrier === p.id) { it.x = p.x; it.z = p.z; }
      // Healing.
      if (p.healUntil && this.time >= p.healUntil) {
        p.healUntil = 0;
        if (p.syringes > 0 && this.isFree(p)) { p.syringes--; p.hp = Math.min(PLAYER.maxHealth, p.hp + PLAYER.syringeHeal); this.event('healed', { id: p.id }); }
      }
      if (!p.downed && p.caught === null && p.hp < PLAYER.regenTo && this.time - p.lastHurt > PLAYER.regenDelay) p.hp = Math.min(PLAYER.regenTo, p.hp + PLAYER.regenPerSecond * dt);
      // Grabbed: struggle or be dragged off.
      if (p.grabbed && this.time >= p.grabbed.until) {
        const e = this.enemies.find(x => x.id === p.grabbed.by);
        this.catchPlayer(p, e);
      }
      // Downed: bleeding out.
      if (p.downed && this.time - p.downedAt >= PLAYER.bleedOutSeconds) {
        this.say('bledOut', p.name);
        this.catchPlayer(p);
      }
      // Reviving a friend.
      if (p.revive) {
        const t = this.players.get(p.revive.target);
        if (!t || !t.downed || !near(p, t, 2.4) || !this.isActive(p)) this.stopRevive(p);
        else if (this.time - p.revive.since >= PLAYER.reviveSeconds) {
          t.downed = false; t.hp = PLAYER.reviveHealth; t.lastHurt = this.time;
          this.stopRevive(p);
          this.room.send(p.id, { t: 'holdDone' });
          this.event('revived', { id: t.id, by: p.id });
          this.say('revived', t.name);
        }
      }
    }

    if (this.lightsOutUntil && !this.lightsOut && !this.lightsBack) {
      this.lightsBack = true;
      for (const e of this.enemies) e.speedMul = Math.max(1.05, this.dyn.exitOpen ? 1.1 : 1.05);
      this.event('lights', { on: true });
      this.say('lightsOn');
    }

    // The Presenter fills the silence.
    this.idleIn -= dt;
    if (this.idleIn <= 0) { this.idleIn = 55 + Math.random() * 45; if (!this.enemies.some(e => e.state === 'chase')) this.say('idle'); }

    if (!this.over) for (const e of this.enemies) e.update(dt);
    this.broadcastSnapshot();
  }

  broadcastSnapshot() {
    const r2 = (v) => Math.round(v * 100) / 100;
    this.room.broadcast({
      t: 'snap',
      time: r2(this.time),
      p: [...this.players.values()].map(p => {
        let sus = 0, chased = 0;
        for (const e of this.enemies) {
          sus = Math.max(sus, e.suspicion.get(p.id) || 0);
          if (e.target === p.id && (e.state === 'chase' || e.state === 'attack')) chased = 1;
        }
        return {
          id: p.id, x: r2(p.x), z: r2(p.z), yaw: r2(p.yaw), pitch: r2(p.pitch),
          c: p.crouch ? 1 : 0, m: p.moving ? 1 : 0, r: p.running ? 1 : 0, radio: p.radio ? 1 : 0,
          hid: p.hidden, hk: p.hiddenTile?.kind || null, caught: p.caught, esc: p.escaped ? 1 : 0,
          carry: p.carrying, th: p.throwable, sy: p.syringes,
          hold: p.holding, bat: Math.round(p.battery * 1000) / 1000,
          hp: Math.round(p.hp), dn: p.downed ? 1 : 0,
          bleed: p.downed ? r2(PLAYER.bleedOutSeconds - (this.time - p.downedAt)) : 0,
          gr: p.grabbed ? r2(p.grabbed.progress) : -1,
          grT: p.grabbed ? r2(p.grabbed.until - this.time) : 0,
          heal: p.healUntil ? r2(1 - (p.healUntil - this.time) / PLAYER.syringeSeconds) : 0,
          rev: p.revive ? r2((this.time - p.revive.since) / PLAYER.reviveSeconds) : 0,
          revT: p.revive?.target ?? null,
          sus: r2(sus), ch: chased,
        };
      }),
      en: this.enemies.map(e => ({ id: e.id, k: e.kind, x: r2(e.x), z: r2(e.z), yaw: r2(e.yaw), s: e.state, m: e.moving ? 1 : 0, sp: r2(e.speed) })),
      doors: [...this.dyn.doors.entries()].filter(([, o]) => o).map(([k]) => k),
      gate: this.dyn.gateOpen ? 1 : 0,
      exit: this.dyn.exitOpen ? 1 : 0,
      bells: this.bells.map(b => (b ? 1 : 0)),
      reels: this.reelsDelivered,
      keyTaken: this.keyTaken ? 1 : 0,
      items: this.items.filter(i => !i.gone).map(i => ({ id: i.id, k: i.kind, x: r2(i.x), z: r2(i.z), c: i.carrier })),
      lights: this.lightsOut ? 0 : 1,
      hunt: this.time >= DETECT.graceSeconds ? 1 : 0,
      lever: this.lever.holder ? Math.min(1, (this.time - this.lever.since) / LESSON.leverHoldSeconds) : 0,
    });
  }
}
