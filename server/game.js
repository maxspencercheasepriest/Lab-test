// One running Lesson: the authoritative simulation for a room.
import { TICK_HZ, PLAYER, NOISE, NV, LESSON, PREFECT } from '../shared/constants.js';
import { parseMap, tileCenter, TILE, MAP, W } from '../shared/map.js';
import { tkey, walkableTiles, collideCircle, isSolidTile } from '../shared/grid.js';
import { pickLine } from '../shared/tannoy.js';
import { Prefect } from './prefect.js';

const near = (a, b, r) => Math.hypot(a.x - b.x, a.z - b.z) <= r;
// Props that fill a whole tile are reachable from the edge of the tile, not the centre.
const PROP_REACH = PLAYER.interactRange + TILE / 2 + 0.4;
const ADJ = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Lesson {
  constructor(room) {
    this.room = room;               // { broadcast(msg), send(id,msg) }
    this.map = parseMap();
    this.time = 0;
    this.over = false;
    this.dyn = { doors: new Map(), gateOpen: false, exitOpen: false };
    for (const d of this.map.doors) this.dyn.doors.set(tkey(d.x, d.z), false);
    this.patrolTiles = walkableTiles(this.dyn).filter(t => MAP[t.z][t.x] === '.' || MAP[t.z][t.x] === 'X');

    this.bells = this.map.bells.map(() => false);
    let id = 0;
    this.items = [];
    for (const t of this.map.reels) this.items.push({ id: id++, kind: 'reel', ...tileCenter(t), carrier: null, gone: false });
    for (const t of this.map.bottles) this.items.push({ id: id++, kind: 'bottle', ...tileCenter(t), carrier: null, gone: false });
    for (const t of this.map.batteries) this.items.push({ id: id++, kind: 'battery', ...tileCenter(t), carrier: null, gone: false });
    this.items.push({ id: id++, kind: 'key', ...tileCenter(this.map.key), carrier: null, gone: false });
    this.reelsDelivered = 0;
    this.keyUsed = false;
    this.plateReleasedAt = -99;
    this.plateHumIn = 0;
    this.plateAnnounced = false;
    this.lever = { holder: null, since: 0 };
    this.lightsOutUntil = 0;
    this.idleIn = 45;
    this.pendingNoises = [];
    this.lastChaseLine = -99;

    this.players = new Map();
    const spawns = this.map.spawns;
    let i = 0;
    for (const p of room.players.values()) {
      const s = tileCenter(spawns[i++ % spawns.length]);
      this.players.set(p.id, {
        id: p.id, name: p.name,
        x: s.x, z: s.z, yaw: Math.PI, pitch: 0,
        crouch: false, moving: false, running: false, radio: false, nv: true,
        battery: 1, hidden: null, caught: null, escaped: false,
        carrying: null, bottle: null, holding: null,
      });
    }
    this.prefect = new Prefect(this, this.map.prefect);

    this.room.broadcast({ t: 'start', you: null, players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, x: p.x, z: p.z })) });
    this.say('start');
    setTimeout(() => !this.over && this.say('tasks'), 9000);
    this.interval = setInterval(() => this.tick(1 / TICK_HZ), 1000 / TICK_HZ);
  }

  stop() { clearInterval(this.interval); }

  // ---- helpers ---------------------------------------------------------

  isActive(p) { return p && p.caught === null && !p.escaped && p.hidden === null; }
  activePlayers() { return [...this.players.values()].filter(p => this.isActive(p)); }
  lockerCheckChance() { return PREFECT.lockerCheckChance + (this.lightsOut ? 0.15 : 0); }
  get lightsOut() { return this.time < this.lightsOutUntil; }

  say(cat, name) {
    const line = pickLine(cat, name);
    if (line) this.room.broadcast({ t: 'tannoy', cat, line });
  }
  event(e, data = {}) { this.room.broadcast({ t: 'ev', e, ...data }); }

  noise(x, z, radius, src) {
    this.prefect.hear(x, z, radius, src);
  }

  setDoor(tile, open, by) {
    const k = tkey(tile.x, tile.z);
    if (this.dyn.doors.get(k) === open) return;
    this.dyn.doors.set(k, open);
    const c = tileCenter(tile);
    this.event('door', { x: tile.x, z: tile.z, open, by });
    if (by !== 'prefect') this.noise(c.x, c.z, NOISE.door, by);
  }

  onPrefectState(s, targetId) {
    this.event('prefect', { s });
    if (s === 'chase' && this.time - this.lastChaseLine > 25) {
      this.lastChaseLine = this.time;
      const t = this.players.get(targetId);
      setTimeout(() => !this.over && this.say('chase', t?.name || ''), 1200);
    }
  }

  // ---- player input ----------------------------------------------------

  onState(id, m) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    p.yaw = +m.yaw || 0; p.pitch = +m.pitch || 0;
    p.radio = !!m.radio; p.nv = !!m.nv;
    if (p.caught !== null || p.hidden !== null || p.escaped) return;
    if (p.holding) { p.moving = false; return; }
    const nx = +m.x, nz = +m.z;
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
    // Loose anti-teleport: friends' game, but keep things sane.
    if (!process.env.DEV && Math.hypot(nx - p.x, nz - p.z) > 4) {
      this.room.send(id, { t: 'correct', x: p.x, z: p.z });
      return;
    }
    const c = collideCircle(nx, nz, PLAYER.radius * 0.8, this.dyn);
    p.x = c.x; p.z = c.z;
    p.crouch = !!m.crouch; p.moving = !!m.moving; p.running = !!m.running;
  }

  onNoise(id, m) {
    const p = this.players.get(id);
    if (!this.isActive(p) && !(p && p.hidden !== null && m.kind === 'talk')) return;
    let r = 0;
    switch (m.kind) {
      case 'walk': r = p.crouch ? NOISE.crouch : NOISE.walk; break;
      case 'run': r = NOISE.run; break;
      case 'talk': r = NOISE.talk + (NOISE.shout - NOISE.talk) * Math.max(0, Math.min(1, +m.level || 0)); break;
      case 'radio': r = NOISE.radio; break;
    }
    if (p.hidden !== null) r *= 0.5;
    this.noise(p.x, p.z, r, id);
  }

  onAct(id, m) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    const a = m.a;

    if (a === 'locker') {
      if (p.hidden !== null) return this.leaveLocker(p);
      if (!this.isActive(p) || p.holding) return;
      const lt = this.map.lockers.find(l => l.x === m.x && l.z === m.z);
      if (!lt || !near(p, tileCenter(lt), PROP_REACH)) return;
      const k = tkey(lt.x, lt.z);
      if ([...this.players.values()].some(o => o.hidden === k)) return this.room.send(id, { t: 'toast', text: 'Occupied.' });
      p.hidden = k;
      p.lockerFrom = { x: p.x, z: p.z };
      const c = tileCenter(lt);
      this.event('locker', { x: c.x, z: c.z, id, open: true });
      this.noise(c.x, c.z, NOISE.locker * (p.running ? 1.6 : 1), id);
      return;
    }
    if (!this.isActive(p)) return;

    if (a === 'door') {
      const d = this.map.doors.find(t => t.x === m.x && t.z === m.z);
      if (!d || !near(p, tileCenter(d), PLAYER.interactRange + 0.8)) return;
      const open = !this.dyn.doors.get(tkey(d.x, d.z));
      if (!open && this.blocking(d)) return; // someone standing in the doorway
      this.setDoor(d, open, id);
      return;
    }
    if (a === 'bell') {
      const i = this.map.bells.findIndex(t => t.x === m.x && t.z === m.z);
      if (i < 0 || this.bells[i] || !near(p, tileCenter(this.map.bells[i]), PROP_REACH)) return;
      this.bells[i] = true;
      const c = tileCenter(this.map.bells[i]);
      this.event('bell', { x: c.x, z: c.z, i });
      this.noise(c.x, c.z, NOISE.bell, id);
      if (this.bells.every(Boolean)) {
        setTimeout(() => {
          if (this.over) return;
          this.say('bellsDone');
          setTimeout(() => {
            if (this.over) return;
            this.lightsOutUntil = this.time + LESSON.lightsOutSeconds;
            this.prefect.speedMul = 1.12;
            this.event('lights', { on: false });
          }, 5500);
        }, 2500);
      } else setTimeout(() => !this.over && this.say('bell', p.name), 1800);
      return;
    }
    if (a === 'pickup') {
      const it = this.items.find(i => i.id === m.item);
      if (!it || it.gone || it.carrier !== null || !near(p, it, PLAYER.interactRange + 0.3)) return;
      if (it.kind === 'battery') {
        it.gone = true;
        p.battery = Math.min(1, p.battery + NV.batteryPickup);
        this.room.send(id, { t: 'toast', text: 'Battery replaced.' });
        return;
      }
      if (it.kind === 'bottle') {
        if (p.bottle !== null) return;
        it.carrier = id; p.bottle = it.id;
        return;
      }
      if (p.carrying !== null) return this.room.send(id, { t: 'toast', text: 'Your hands are full.' });
      it.carrier = id; p.carrying = it.id;
      if (it.kind === 'key') this.say('key', p.name);
      return;
    }
    if (a === 'drop') return this.dropCarried(p);
    if (a === 'projector') {
      const it = this.items.find(i => i.id === p.carrying);
      if (!it || it.kind !== 'reel' || !near(p, tileCenter(this.map.projector), PROP_REACH)) return;
      it.gone = true; it.carrier = null; p.carrying = null;
      this.reelsDelivered++;
      this.event('projector', { n: this.reelsDelivered });
      this.noise(p.x, p.z, 7, id);
      this.say(this.reelsDelivered === this.map.reels.length ? 'reelsDone' : 'reel', p.name);
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
      if (this.reelsDelivered < this.map.reels.length) needs.push('the reels');
      if (!it || it.kind !== 'key') needs.push('the study key');
      if (needs.length) return this.room.send(id, { t: 'toast', text: `Locked. Still to do: ${needs.join(', ')}.` });
      it.gone = true; it.carrier = null; p.carrying = null;
      this.keyUsed = true;
      this.dyn.exitOpen = true;
      this.event('exit', {});
      this.noise(p.x, p.z, 20, id);
      this.say('exitOpen');
      return;
    }
  }

  onHold(id, m) {
    const p = this.players.get(id);
    if (!p || !this.isActive(p)) return;
    if (!m.on) {
      if (p.holding === 'plate') this.plateReleasedAt = this.time;
      if (p.holding === 'lever' && this.lever.holder === id) this.lever.holder = null;
      p.holding = null;
      return;
    }
    if (m.a === 'plate' && near(p, tileCenter(this.map.plate), 1.4)) {
      p.holding = 'plate';
      if (!this.plateAnnounced) { this.plateAnnounced = true; this.say('plate'); }
    } else if (m.a === 'lever' && near(p, tileCenter(this.map.lever), PROP_REACH)) {
      if (this.lever.holder && this.lever.holder !== id) return;
      p.holding = 'lever';
      this.lever = { holder: id, since: this.time };
      this.event('lever', { on: true });
    }
  }

  onThrow(id, m) {
    const p = this.players.get(id);
    if (!this.isActive(p) || p.bottle === null) return;
    const it = this.items.find(i => i.id === p.bottle);
    p.bottle = null;
    it.gone = true; it.carrier = null;
    let tx = +m.x, tz = +m.z;
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
    const d = Math.hypot(tx - p.x, tz - p.z);
    if (d > 18) { tx = p.x + (tx - p.x) / d * 18; tz = p.z + (tz - p.z) / d * 18; }
    const delay = 0.25 + Math.min(d, 18) / 14;
    this.event('throw', { id, x: p.x, z: p.z, tx, tz, delay });
    this.pendingNoises.push({ at: this.time + delay, x: tx, z: tz, r: NOISE.bottle, src: id, ev: 'smash' });
  }

  // ---- state changes ---------------------------------------------------

  dropCarried(p) {
    for (const key of ['carrying', 'bottle']) {
      const it = this.items.find(i => i.id === p[key]);
      if (it) { it.carrier = null; it.x = p.x; it.z = p.z; }
      p[key] = null;
    }
  }

  blocking(tile) {
    const c = tileCenter(tile);
    const all = [...this.players.values()].filter(p => p.caught === null && !p.escaped && p.hidden === null);
    all.push(this.prefect);
    return all.some(o => Math.abs(o.x - c.x) < TILE / 2 + 0.3 && Math.abs(o.z - c.z) < TILE / 2 + 0.3);
  }

  leaveLocker(p) {
    const lt = { x: p.hidden % W, z: Math.floor(p.hidden / W) };
    p.hidden = null;
    // Step out in front of the locker (towards where they came from if possible).
    const opts = ADJ.map(([dx, dz]) => ({ x: lt.x + dx, z: lt.z + dz }))
      .filter(t => !isSolidTile(t.x, t.z, this.dyn));
    const from = p.lockerFrom || tileCenter(lt);
    opts.sort((a, b) => Math.hypot(tileCenter(a).x - from.x, tileCenter(a).z - from.z) - Math.hypot(tileCenter(b).x - from.x, tileCenter(b).z - from.z));
    const out = opts[0] ? tileCenter(opts[0]) : from;
    const lc = tileCenter(lt);
    // Stand just in front of the locker, not in the middle of the next tile.
    p.x = lc.x + (out.x - lc.x) * 0.62; p.z = lc.z + (out.z - lc.z) * 0.62;
    this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    this.event('locker', { x: lc.x, z: lc.z, id: p.id, open: false });
    this.noise(lc.x, lc.z, NOISE.locker, p.id);
  }

  prefectOpensLocker(lt) {
    const k = tkey(lt.x, lt.z);
    const c = tileCenter(lt);
    this.event('lockerCheck', { x: c.x, z: c.z });
    const p = [...this.players.values()].find(o => o.hidden === k);
    if (p) {
      p.hidden = null;
      p.x = c.x; p.z = c.z;
      this.catchPlayer(p);
      this.prefect.setState('caughtPause');
    }
  }

  catchPlayer(p) {
    if (p.caught !== null) return;
    this.dropCarried(p);
    if (p.holding === 'plate') this.plateReleasedAt = this.time;
    p.holding = null;
    const used = new Set([...this.players.values()].map(o => o.caught).filter(c => c !== null));
    let cage = 0;
    while (used.has(cage)) cage++;
    p.caught = cage;
    const cageTile = this.map.cages[cage % this.map.cages.length];
    const c = tileCenter(cageTile);
    this.event('caught', { id: p.id, x: p.x, z: p.z });
    p.x = c.x + (cage >= this.map.cages.length ? 0.4 : 0); p.z = c.z;
    this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    setTimeout(() => !this.over && this.say('caught', p.name), 1500);
    this.checkEnd();
  }

  freeAll() {
    const caged = [...this.players.values()].filter(p => p.caught !== null && !p.escaped);
    if (!caged.length) return;
    const lv = tileCenter(this.map.lever);
    for (const p of caged) {
      p.caught = null;
      p.x = lv.x + 1.2 + Math.random() * 0.8; p.z = lv.z - 1.0 - Math.random() * 1.5;
      this.room.send(p.id, { t: 'correct', x: p.x, z: p.z });
    }
    this.event('freed', { ids: caged.map(p => p.id) });
    this.noise(lv.x, lv.z, 12, null);
    this.say('freed');
  }

  checkEnd() {
    if (this.over) return;
    const all = [...this.players.values()];
    if (!all.length) return;
    const free = all.filter(p => p.caught === null && !p.escaped);
    const escaped = all.filter(p => p.escaped);
    if (free.length) return;
    this.over = true;
    const win = escaped.length > 0;
    setTimeout(() => {
      this.say(win ? 'win' : 'fail');
      this.event('end', { win, escaped: escaped.map(p => p.name), kept: all.filter(p => !p.escaped).map(p => p.name), time: Math.round(this.time) });
      setTimeout(() => this.room.endLesson(), 1000);
    }, win ? 500 : 3000);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.dropCarried(p);
    this.players.delete(id);
    if (this.prefect.target === id) this.prefect.lostTarget();
    this.checkEnd();
  }

  // ---- tick ------------------------------------------------------------

  tick(dt) {
    if (this.over && !this.endingSnap) { this.endingSnap = true; }
    this.time += dt;

    // Delayed noises (thrown bottles landing).
    this.pendingNoises = this.pendingNoises.filter(n => {
      if (n.at > this.time) return true;
      this.event(n.ev, { x: n.x, z: n.z });
      this.noise(n.x, n.z, n.r, n.src);
      return false;
    });

    // Pressure plate and gate.
    const plate = tileCenter(this.map.plate);
    const onPlate = [...this.players.values()].filter(p => p.holding === 'plate' && this.isActive(p) && near(p, plate, 1.6));
    const solo = this.players.size === 1;
    const wasOpen = this.dyn.gateOpen;
    let open = onPlate.length > 0 || this.time - this.plateReleasedAt < (solo ? LESSON.plateGraceSolo : LESSON.plateGraceSeconds);
    if (!open && wasOpen && this.map.gates.some(g => this.blocking(g))) open = true;
    this.dyn.gateOpen = open;
    if (open !== wasOpen) this.event('gate', { open });
    if (onPlate.length) {
      this.plateHumIn -= dt;
      if (this.plateHumIn <= 0) { this.plateHumIn = 1; this.noise(plate.x, plate.z, NOISE.plateHum, null); }
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

    // Night-vision batteries.
    for (const p of this.players.values()) {
      if (p.nv && p.caught === null && !p.escaped) p.battery = Math.max(0, p.battery - NV.drainPerSecond * dt);
      if (p.carrying !== null || p.bottle !== null) {
        for (const it of this.items) if (it.carrier === p.id) { it.x = p.x; it.z = p.z; }
      }
    }

    if (this.lightsOutUntil && !this.lightsOut && !this.lightsBack) {
      this.lightsBack = true;
      this.prefect.speedMul = 1.05;
      this.event('lights', { on: true });
      this.say('lightsOn');
    }

    // The Presenter fills the silence.
    this.idleIn -= dt;
    if (this.idleIn <= 0) { this.idleIn = 50 + Math.random() * 40; if (this.prefect.state !== 'chase') this.say('idle'); }

    if (!this.over) this.prefect.update(dt);
    this.broadcastSnapshot();
  }

  broadcastSnapshot() {
    const f = this.prefect;
    this.room.broadcast({
      t: 'snap',
      time: +this.time.toFixed(2),
      p: [...this.players.values()].map(p => ({
        id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), yaw: +p.yaw.toFixed(2), pitch: +p.pitch.toFixed(2),
        c: p.crouch ? 1 : 0, m: p.moving ? 1 : 0, r: p.running ? 1 : 0, radio: p.radio ? 1 : 0,
        hid: p.hidden, caught: p.caught, esc: p.escaped ? 1 : 0, carry: p.carrying, bottle: p.bottle,
        hold: p.holding, bat: +p.battery.toFixed(3),
      })),
      f: { x: +f.x.toFixed(2), z: +f.z.toFixed(2), yaw: +f.yaw.toFixed(2), s: f.state, m: f.moving ? 1 : 0, sp: +f.speed.toFixed(2) },
      doors: [...this.dyn.doors.entries()].filter(([, o]) => o).map(([k]) => k),
      gate: this.dyn.gateOpen ? 1 : 0,
      exit: this.dyn.exitOpen ? 1 : 0,
      bells: this.bells.map(b => (b ? 1 : 0)),
      reels: this.reelsDelivered,
      items: this.items.filter(i => !i.gone).map(i => ({ id: i.id, k: i.kind, x: +i.x.toFixed(2), z: +i.z.toFixed(2), c: i.carrier })),
      lights: this.lightsOut ? 0 : 1,
      lever: this.lever.holder ? Math.min(1, (this.time - this.lever.since) / LESSON.leverHoldSeconds) : 0,
    });
  }
}
