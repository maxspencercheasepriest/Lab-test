// Headless checks of the Lesson simulation and the network server.
// Run with: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Lesson } from '../server/game.js';
import { Enemy } from '../server/enemy.js';
import { tileCenter, roomAt, toTile, ROOMS } from '../shared/map.js';
import { findPath, tkey } from '../shared/grid.js';
import { PLAYER, GRAB } from '../shared/constants.js';

function fakeRoom(n) {
  const log = [];
  const players = new Map();
  for (let i = 1; i <= n; i++) players.set(i, { id: i, name: `P${i}` });
  return { players, log, broadcast: (m) => log.push(m), send: (id, m) => log.push({ to: id, ...m }), endLesson() { this.ended = true; } };
}
const make = (n = 1) => { const room = fakeRoom(n); const L = new Lesson(room, { manual: true }); return { L, room }; };
const run = (L, seconds, each) => { const dt = 1 / 15; for (let t = 0; t < seconds; t += dt) { each?.(t); L.tick(dt); } };
const hideAway = (L, p) => { const h = L.map.lockers[p.id]; p.hidden = tkey(h.x, h.z); p.hiddenTile = { ...h, kind: 'locker' }; };
const at = (o, tx, tz) => { const c = tileCenter({ x: tx, z: tz }); o.x = c.x; o.z = c.z; };
// One enemy of a kind, standing at a tile and facing +x along the corridor.
function soloEnemy(L, kind, tx = 8, tz = 10) {
  const e = new Enemy(L, 99, kind, { x: tx, z: tz });
  e.yaw = Math.PI / 2; e.pause = 0;
  L.enemies = [e];
  L.time = 20; // past the opening grace period
  return e;
}

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e]); } };

test('items are shuffled: 3 reels in different rooms, plus throwables, syringes, batteries', () => {
  const { L } = make();
  const reels = L.items.filter(i => i.kind === 'reel');
  assert.equal(reels.length, 3);
  assert.equal(new Set(reels.map(r => roomAt(toTile(r.x, r.z).x, toTile(r.x, r.z).z)?.name)).size, 3);
  for (const k of ['bottle', 'brick', 'syringe', 'battery', 'key']) assert.ok(L.items.some(i => i.kind === k), k);
});

test('enemies roam room to room instead of homing in', () => {
  const { L } = make(1);
  hideAway(L, L.players.get(1));
  const visited = new Map(L.enemies.map(e => [e.id, new Set()]));
  run(L, 120, () => { for (const e of L.enemies) if (e.room) visited.get(e.id).add(e.room.name); });
  for (const [id, rooms] of visited) assert.ok(rooms.size >= 2, `enemy ${id} only visited ${[...rooms]}`);
  assert.ok(L.enemies.every(e => e.state !== 'chase'));
});

test('nobody hunts during the opening grace period', () => {
  const { L } = make(1);
  const e = soloEnemy(L, 'prefect'); L.time = 0;
  const p = L.players.get(1); at(p, 11, 10); p.moving = true;
  run(L, 5);
  assert.notEqual(e.state, 'chase');
});

test('a distant glimpse makes it curious before it gives chase', () => {
  const { L } = make(1);
  const e = soloEnemy(L, 'prefect');
  e.updatePatrol = () => {}; // stand still, looking down the corridor
  const p = L.players.get(1); at(p, 13, 10); p.moving = true; // 12.5m away
  run(L, 0.6);
  assert.notEqual(e.state, 'chase', 'should not chase instantly at range');
  run(L, 6);
  assert.ok(['chase', 'grab'].includes(e.state) || p.grabbed, `state ${e.state}`);
});

test('crouching still in the dark at range is not noticed quickly', () => {
  const { L } = make(1);
  const e = soloEnemy(L, 'orderly');
  const p = L.players.get(1); at(p, 12, 10); p.crouch = true; p.moving = false;
  e.update = ((orig) => function (dt) { this.pause = 0; orig.call(this, dt); this.x = tileCenter({ x: 8, z: 10 }).x; this.yaw = Math.PI / 2; })(e.update);
  run(L, 3);
  assert.notEqual(e.state, 'chase');
});

test('a noise sends an enemy to investigate, then search, then back to patrol', () => {
  const { L } = make(1);
  hideAway(L, L.players.get(1));
  const e = soloEnemy(L, 'orderly');
  const c = tileCenter({ x: 11, z: 10 });
  L.noise(c.x, c.z, 12);
  assert.equal(e.state, 'investigate');
  run(L, 12);
  assert.ok(['search', 'patrol'].includes(e.state), e.state);
  run(L, 30);
  assert.equal(e.state, 'patrol');
});

test('Prefect grabs; struggling free stuns it and costs health', () => {
  const { L } = make(1);
  const e = soloEnemy(L, 'prefect');
  const p = L.players.get(1); at(p, 9, 10); p.moving = true;
  run(L, 2);
  assert.ok(p.grabbed, `not grabbed, state ${e.state}`);
  for (let i = 0; i < 12; i++) { L.time += 0.1; L.onStruggle(1); }
  assert.equal(p.grabbed, null);
  assert.equal(e.state, 'stunned');
  assert.equal(p.hp, PLAYER.maxHealth - GRAB.escapeDamage);
});

test('Prefect grab without struggling drags you to Correction', () => {
  const { L } = make(2);
  hideAway(L, L.players.get(2));
  const e = soloEnemy(L, 'prefect');
  const p = L.players.get(1); at(p, 9, 10); p.moving = true;
  run(L, 2 + GRAB.seconds + 0.5);
  assert.notEqual(p.caught, null);
});

test('Orderly beats you down; a friend revives you', () => {
  const { L } = make(2);
  const e = soloEnemy(L, 'orderly');
  const a = L.players.get(1), b = L.players.get(2);
  hideAway(L, b);
  at(a, 9, 10); a.moving = true;
  run(L, 12, () => { if (!a.downed) { a.x = e.x + 1.0; a.z = e.z; } });
  assert.equal(a.downed, true, `hp ${a.hp}`);
  assert.equal(e.target, null);
  b.hidden = null; b.x = a.x + 1; b.z = a.z;
  L.enemies = [];
  L.onHold(2, { a: 'revive', on: true, target: 1 });
  run(L, PLAYER.reviveSeconds + 0.3);
  assert.equal(a.downed, false);
  assert.equal(a.hp, PLAYER.reviveHealth);
});

test('bleeding out sends you to Correction; lever frees you', () => {
  const { L } = make(2);
  L.enemies = [];
  const a = L.players.get(1), b = L.players.get(2);
  L.downPlayer(a);
  run(L, PLAYER.bleedOutSeconds + 0.5);
  assert.notEqual(a.caught, null);
  const lv = tileCenter(L.map.lever); b.x = lv.x - 1.3; b.z = lv.z;
  L.onHold(2, { a: 'lever', on: true });
  run(L, 3.5);
  assert.equal(a.caught, null);
});

test('everyone down or caught ends the Lesson', () => {
  const { L } = make(2);
  L.enemies = [];
  L.downPlayer(L.players.get(1));
  assert.equal(L.over, false);
  L.catchPlayer(L.players.get(2));
  assert.equal(L.over, true);
});

test('a thrown bottle stuns an enemy and frees a grabbed friend', () => {
  const { L } = make(2);
  const e = soloEnemy(L, 'prefect');
  const a = L.players.get(1), b = L.players.get(2);
  at(a, 9, 10); hideAway(L, b);
  L.grabPlayer(e, a);
  b.hidden = null; at(b, 14, 10);
  const bottle = L.items.find(i => i.kind === 'bottle');
  bottle.x = b.x; bottle.z = b.z; L.onAct(2, { a: 'pickup', item: bottle.id });
  assert.equal(b.throwable, bottle.id);
  L.onThrow(2, { x: e.x - 3, z: e.z });
  run(L, 1.5);
  assert.equal(a.grabbed, null);
  assert.equal(a.hp, PLAYER.maxHealth);
  assert.ok(['stunned', 'search'].includes(e.state), e.state);
});

test('slamming a door on an enemy stuns it', () => {
  const { L } = make(1);
  const p = L.players.get(1);
  const d = L.map.doors.find(t => t.x === 6 && t.z === 8); // dormitory door
  const e = soloEnemy(L, 'orderly', 6, 9);
  L.dyn.doors.set(tkey(d.x, d.z), true);
  const c = tileCenter(d); e.x = c.x; e.z = c.z + 0.6;
  at(p, 6, 7);
  L.onAct(1, { a: 'door', x: 6, z: 8 });
  assert.equal(e.state, 'stunned');
  assert.equal(L.dyn.doors.get(tkey(6, 8)), false);
});

test('an enemy checking your hiding place: Prefect takes you, Orderly drags you out', () => {
  {
    const { L } = make(2);
    const e = soloEnemy(L, 'prefect');
    const p = L.players.get(1); const h = L.map.beds[0];
    p.hidden = tkey(h.x, h.z); p.hiddenTile = { ...h, kind: 'bed' };
    L.enemyChecksHide(e, { ...h, kind: 'bed' });
    assert.notEqual(p.caught, null);
  }
  {
    const { L } = make(2);
    const e = soloEnemy(L, 'orderly');
    const p = L.players.get(1); const h = L.map.lockers[3];
    p.hidden = tkey(h.x, h.z); p.hiddenTile = { ...h, kind: 'locker' };
    L.enemyChecksHide(e, { ...h, kind: 'locker' });
    assert.equal(p.hidden, null);
    assert.ok(p.hp < PLAYER.maxHealth);
  }
});

test('syringes heal over a short use', () => {
  const { L } = make(1);
  L.enemies = [];
  const p = L.players.get(1);
  const s = L.items.find(i => i.kind === 'syringe');
  p.x = s.x; p.z = s.z; L.onAct(1, { a: 'pickup', item: s.id });
  assert.equal(p.syringes, 1);
  p.hp = 20; p.lastHurt = L.time;
  L.onAct(1, { a: 'heal' });
  run(L, PLAYER.syringeSeconds + 0.2);
  assert.equal(p.syringes, 0);
  assert.ok(p.hp >= 20 + PLAYER.syringeHeal - 1);
});

test('plate opens the gate; gate shuts after leaving', () => {
  const { L } = make(2);
  L.enemies = [];
  const a = L.players.get(1);
  hideAway(L, L.players.get(2));
  const pl = tileCenter(L.map.plate);
  a.x = pl.x; a.z = pl.z;
  L.onHold(1, { a: 'plate', on: true });
  L.tick(1 / 15);
  assert.equal(L.dyn.gateOpen, true);
  L.onHold(1, { a: 'plate', on: false });
  run(L, 2);
  assert.equal(L.dyn.gateOpen, false);
});

test('full win path: bells, reels, key, exit — and a new Orderly arrives after the reels', () => {
  const { L } = make(1);
  L.enemies = [];
  const p = L.players.get(1);
  const go = (t) => { const c = tileCenter(t); p.x = c.x + 1.2; p.z = c.z; };
  L.map.bells.forEach(b => { go(b); L.onAct(1, { a: 'bell', x: b.x, z: b.z }); });
  assert.ok(L.bells.every(Boolean));
  for (const reel of L.items.filter(i => i.kind === 'reel')) {
    p.x = reel.x; p.z = reel.z; L.onAct(1, { a: 'pickup', item: reel.id });
    go(L.map.projector); L.onAct(1, { a: 'projector' });
  }
  assert.equal(L.reelsDelivered, 3);
  run(L, 7);
  assert.equal(L.enemies.length, 1);
  L.enemies = [];
  const key = L.items.find(i => i.kind === 'key');
  p.x = key.x; p.z = key.z; L.onAct(1, { a: 'pickup', item: key.id });
  assert.equal(L.keyTaken, true);
  const ex = L.map.exits[0];
  p.x = tileCenter(ex).x; p.z = tileCenter(ex).z - 2;
  L.onAct(1, { a: 'exit' });
  assert.equal(L.dyn.exitOpen, true);
  L.onAct(1, { a: 'exit' });
  assert.equal(p.escaped, true);
  assert.equal(L.over, true);
});

test('pathfinding across the whole wing', () => {
  const { L } = make(1);
  const p = findPath(L.map.spawns[0], { x: 40, z: 26 }, L.dyn);
  assert.ok(p && p.length > 30);
});

// ---- network smoke test ------------------------------------------------

async function netTest() {
  const PORT = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT }, stdio: 'pipe' });
  await new Promise(r => srv.stdout.on('data', r));
  const open = () => new Promise(r => { const w = new WebSocket(`ws://localhost:${PORT}`); w.msgs = []; w.on('message', d => w.msgs.push(JSON.parse(d))); w.on('open', () => r(w)); });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    const a = await open();
    a.send(JSON.stringify({ t: 'join', name: 'Alice' }));
    await wait(150);
    const code = a.msgs.find(m => m.t === 'welcome').code;
    const b = await open();
    b.send(JSON.stringify({ t: 'join', name: 'Bob', code }));
    await wait(150);
    assert.equal(b.msgs.find(m => m.t === 'lobby').players.length, 2);
    a.send(JSON.stringify({ t: 'start' }));
    await wait(500);
    assert.ok(b.msgs.some(m => m.t === 'start'));
    const snaps = b.msgs.filter(m => m.t === 'snap');
    assert.ok(snaps.length >= 4);
    assert.equal(snaps.at(-1).en.length, 3);
    b.send(JSON.stringify({ t: 'rtc', to: a.msgs.find(m => m.t === 'welcome').id, data: { hello: 1 } }));
    await wait(150);
    assert.ok(a.msgs.some(m => m.t === 'rtc' && m.data.hello === 1));
    for (const f of ['/vendor/three/three.module.js', '/shared/map.js', '/js/arms.js']) {
      const res = await fetch(`http://localhost:${PORT}${f}`);
      assert.equal(res.status, 200, f);
    }
    a.close(); b.close();
    results.push(['ok', 'network: rooms, start, snapshots, voice relay, static files']);
  } catch (e) {
    results.push(['FAIL', 'network', e]);
  } finally { srv.kill(); }
}

await netTest();
let failed = 0;
for (const [s, n, e] of results) { console.log(`${s.padEnd(4)} ${n}`); if (e) { failed++; console.log('     ', e.message); } }
process.exit(failed ? 1 : 0);
