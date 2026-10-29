// Headless checks of the Lesson simulation and the network server.
// Run with: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Lesson } from '../server/game.js';
import { tileCenter } from '../shared/map.js';
import { findPath, tkey } from '../shared/grid.js';
import { toTile } from '../shared/map.js';

function fakeRoom(n) {
  const log = [];
  const players = new Map();
  for (let i = 1; i <= n; i++) players.set(i, { id: i, name: `P${i}` });
  return { players, log, broadcast: (m) => log.push(m), send: (id, m) => log.push({ to: id, ...m }), endLesson() { this.ended = true; } };
}

function run(lesson, seconds, each) {
  const dt = 1 / 15;
  for (let t = 0; t < seconds; t += dt) { each?.(t); lesson.tick(dt); if (lesson.over) break; }
}

const results = [];
const test = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, e]); } };

test('prefect patrols and moves', () => {
  const room = fakeRoom(1);
  const L = new Lesson(room); L.stop();
  // Park the player out of the way inside a locker so it isn't seen.
  const p = L.players.get(1);
  p.hidden = tkey(L.map.lockers[0].x, L.map.lockers[0].z);
  const start = { x: L.prefect.x, z: L.prefect.z };
  run(L, 20);
  const moved = Math.hypot(L.prefect.x - start.x, L.prefect.z - start.z);
  assert.ok(moved > 3, `prefect moved only ${moved}`);
});

test('a loud noise makes the prefect investigate', () => {
  const room = fakeRoom(1);
  const L = new Lesson(room); L.stop();
  L.players.get(1).hidden = tkey(L.map.lockers[0].x, L.map.lockers[0].z);
  const c = tileCenter(L.map.bells[0]);
  L.noise(c.x, c.z, 60, 1);
  assert.equal(L.prefect.state, 'investigate');
  run(L, 30, () => {});
  const d = Math.hypot(L.prefect.x - c.x, L.prefect.z - c.z);
  assert.ok(L.prefect.state === 'search' || L.prefect.state === 'patrol', L.prefect.state);
});

test('a player standing in front of the prefect gets caught and caged', () => {
  const room = fakeRoom(2);
  const L = new Lesson(room); L.stop();
  const p = L.players.get(1);
  L.players.get(2).hidden = tkey(L.map.lockers[0].x, L.map.lockers[0].z);
  p.x = L.prefect.x; p.z = L.prefect.z + 4; L.prefect.yaw = 0; // yaw 0 faces +z
  run(L, 6);
  assert.notEqual(p.caught, null, `state ${L.prefect.state}`);
  assert.ok(room.log.some(m => m.t === 'ev' && m.e === 'caught'));
});

test('everyone caught ends the lesson as a fail', () => {
  const room = fakeRoom(1);
  const L = new Lesson(room); L.stop();
  L.catchPlayer(L.players.get(1));
  assert.equal(L.over, true);
});

test('lever frees caged players', () => {
  const room = fakeRoom(2);
  const L = new Lesson(room); L.stop();
  const a = L.players.get(1), b = L.players.get(2);
  L.catchPlayer(b);
  const lv = tileCenter(L.map.lever);
  a.x = lv.x + 1.4; a.z = lv.z;
  L.onHold(1, { a: 'lever', on: true });
  run(L, 3.5);
  assert.equal(b.caught, null);
});

test('plate opens the gate; gate shuts after leaving', () => {
  const room = fakeRoom(2);
  const L = new Lesson(room); L.stop();
  const a = L.players.get(1);
  L.players.get(2).hidden = tkey(L.map.lockers[0].x, L.map.lockers[0].z);
  const pl = tileCenter(L.map.plate);
  a.x = pl.x; a.z = pl.z;
  L.onHold(1, { a: 'plate', on: true });
  L.tick(1 / 15);
  assert.equal(L.dyn.gateOpen, true);
  L.onHold(1, { a: 'plate', on: false });
  run(L, 2);
  assert.equal(L.dyn.gateOpen, false);
});

test('full win path: bells, reels, key, exit', () => {
  const room = fakeRoom(1);
  const L = new Lesson(room); L.stop();
  L.prefect.update = () => {}; // keep it out of this test
  const p = L.players.get(1);
  const go = (t) => { const c = tileCenter(t); p.x = c.x + 1.2; p.z = c.z; };
  L.map.bells.forEach(b => { go(b); L.onAct(1, { a: 'bell', x: b.x, z: b.z }); });
  assert.ok(L.bells.every(Boolean));
  for (const reel of L.items.filter(i => i.kind === 'reel')) {
    p.x = reel.x; p.z = reel.z; L.onAct(1, { a: 'pickup', item: reel.id });
    go(L.map.projector); L.onAct(1, { a: 'projector' });
  }
  assert.equal(L.reelsDelivered, 3);
  const key = L.items.find(i => i.kind === 'key');
  p.x = key.x; p.z = key.z; L.onAct(1, { a: 'pickup', item: key.id });
  const ex = L.map.exits[0];
  go(ex); L.onAct(1, { a: 'exit' });
  assert.equal(L.dyn.exitOpen, true);
  L.onAct(1, { a: 'exit' });
  assert.equal(p.escaped, true);
  assert.equal(L.over, true);
});

test('pathfinding across the whole wing', () => {
  const room = fakeRoom(1);
  const L = new Lesson(room); L.stop();
  const p = findPath(L.map.spawns[0], { x: 34, z: 21 }, L.dyn);
  assert.ok(p && p.length > 20);
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
    assert.ok(b.msgs.filter(m => m.t === 'snap').length >= 4);
    b.send(JSON.stringify({ t: 'rtc', to: a.msgs.find(m => m.t === 'welcome').id, data: { hello: 1 } }));
    await wait(150);
    assert.ok(a.msgs.some(m => m.t === 'rtc' && m.data.hello === 1));
    const res = await fetch(`http://localhost:${PORT}/vendor/three/three.module.js`);
    assert.equal(res.status, 200);
    const res2 = await fetch(`http://localhost:${PORT}/shared/map.js`);
    assert.equal(res2.status, 200);
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
