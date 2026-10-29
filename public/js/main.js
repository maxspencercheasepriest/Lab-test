// The Programme — browser client.
import * as THREE from 'three';
import { TILE, MAP, W, tileCenter, toTile } from '/shared/map.js';
import { tkey, collideCircle, lineOfSight, isSolidTile } from '/shared/grid.js';
import { PLAYER, TICK_HZ } from '/shared/constants.js';
import { Net } from './net.js';
import { World, angleDiff } from './world.js';
import { makeTextures } from './textures.js';
import { NightVision } from './nightvision.js';
import { Sound } from './audio.js';
import { Voice } from './voice.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- renderer & scene -----------------------------------------------------

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.autoClear = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.032);
const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 90);
camera.rotation.order = 'YXZ';
scene.add(camera);

// The pupil's own infrared illuminator (only lights the world in *your* view).
const irLight = new THREE.PointLight(0xffffff, 0, 22, 1.0);
const TUNE = { irPower: 40, darkAdapt: 0.5 };
camera.add(irLight);

const world = new World(scene, makeTextures());
world.lights.push(irLight);
world.prefect.g.visible = false;
const nv = new NightVision(renderer);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  nv.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---- state ---------------------------------------------------------------

const net = new Net();
const sound = new Sound();
const voice = new Voice(net, sound);

const S = {
  phase: 'lobby',     // lobby | game
  myId: null, host: null, names: new Map(),
  snap: null, me: null,
  x: 0, z: 0, yaw: 0, pitch: 0, eye: PLAYER.eyeHeight,
  crouch: false, stamina: 1, exhausted: 0, stepAcc: 0, bob: 0, moving: false, running: false,
  nvOn: true, holding: null, sentEscape: false,
  keys: new Set(), locked: false,
  sendIn: 0, talkIn: 0, radioIn: 0, radio: false,
  remoteSteps: new Map(), prefectStep: 0, prefectBreathIn: 3, lastPrefectState: 'patrol',
  fear: 0, chaseStingAt: -99, time: 0, creakIn: 12,
  fade: 0, bottles: [],
};

// ---- lobby UI -----------------------------------------------------------

$('name').value = localStorage.getItem('programme.name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('code').value = params.get('room').toUpperCase();

// Desktop app: the app runs its own server. Creating a room hosts on this computer;
// joining a friend means typing their address.
const desktop = window.programmeDesktop || null;
if (desktop) {
  document.body.classList.add('desktop');
  $('server').value = localStorage.getItem('programme.server') || '';
}

async function join(code) {
  $('error').textContent = '';
  const name = $('name').value.trim() || 'Pupil';
  localStorage.setItem('programme.name', name);
  await sound.init();
  sound.resume();
  // Hosting (no code) always uses this computer. Joining uses the typed address, if any.
  let addr = '';
  if (desktop && code) {
    addr = $('server').value.trim();
    localStorage.setItem('programme.server', addr);
  }
  S.hosting = !code;
  try { await net.connect(addr); } catch {
    $('error').textContent = addr ? `Could not reach ${addr}. Check the address, and that the host has let the game through their firewall.` : 'Could not reach the server.';
    return;
  }
  await voice.start();
  net.send({ t: 'join', name, code });
}
$('create').onclick = () => join('');
$('joinBtn').onclick = () => join($('code').value.trim());
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && join($('code').value.trim()));
$('start').onclick = () => net.send({ t: 'start' });

net.on('error', (m) => { $('error').textContent = m.text; });
net.on('close', () => { $('error').textContent = 'Disconnected from the server.'; showLobby(); $('join').classList.remove('hidden'); $('room').classList.add('hidden'); });
net.on('welcome', (m) => {
  S.myId = m.id;
  $('join').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('roomCode').textContent = m.code;
  if (!desktop) history.replaceState(null, '', `?room=${m.code}`);
  $('hostInfo').innerHTML = '';
  if (desktop && S.hosting) {
    desktop.info().then(({ port, lan }) => {
      const p = port === 80 ? '' : `:${port}`;
      const local = lan.map(ip => `<b>${ip}${p}</b>`).join(' or ') || '(no network found)';
      $('hostInfo').innerHTML = `You're hosting. Friends type your address and the code.<br>` +
        `Same Wi-Fi / network: ${local}<br>` +
        `Over the internet: forward port <b>${port}</b> (TCP) on your router to this computer, and give them your public IP with <b>${p || ':80'}</b> on the end.`;
    });
  }
});
net.on('lobby', (m) => {
  S.host = m.host;
  S.names = new Map(m.players.map(p => [p.id, p.name]));
  $('roster').innerHTML = m.players.map(p => `<li>${escapeHtml(p.name)}${p.id === m.host ? ' (host)' : ''}${p.id === S.myId ? ' — you' : ''}</li>`).join('');
  const isHost = m.host === S.myId;
  $('start').classList.toggle('hidden', !isHost);
  $('waiting').classList.toggle('hidden', isHost);
  $('micState').textContent = voice.status === 'on' ? 'Microphone on — your friends can hear you.' : voice.status === 'denied' ? 'No microphone (voice chat off). You can still hear others.' : '';
  voice.sync(S.myId, m.players.map(p => p.id));
  if (!m.inLesson && S.phase === 'game') endGame();
});
net.on('peerLeft', (m) => { voice.drop(m.id); world.removeAvatar(m.id); });
net.on('rtc', (m) => voice.onSignal(m.from, m.data));

function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function showLobby() {
  S.phase = 'lobby';
  $('lobby').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('resume').classList.add('hidden');
  world.prefect.g.visible = false;
  document.exitPointerLock?.();
}

// ---- lesson start / end --------------------------------------------------

net.on('start', (m) => {
  S.phase = 'game';
  S.snap = null; S.me = null;
  const me = m.players.find(p => p.id === S.myId);
  S.x = me.x; S.z = me.z; S.yaw = 0; S.pitch = 0;
  S.crouch = false; S.stamina = 1; S.holding = null; S.sentEscape = false; S.nvOn = true; S.fade = 1;
  for (const id of [...world.players.keys()]) world.removeAvatar(id);
  for (const p of m.players) if (p.id !== S.myId) world.makeAvatar(p.id, p.name);
  world.prefect.init = false;
  world.prefect.g.visible = true;
  for (const b of world.bellMeshes) { b.rung = false; b.t = 99; }
  world.projectorOn = 0; world.projectorLight.intensity = 0;
  $('lobby').classList.add('hidden');
  $('end').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('resume').classList.remove('hidden');
  $('resume').querySelector('p').textContent = 'Click to begin the Lesson';
});

net.on('ev', (m) => {
  if (m.e === 'end') {
    document.exitPointerLock?.();
    $('end').classList.remove('hidden');
    $('endTitle').textContent = m.win ? 'LESSON COMPLETE' : 'LESSON FAILED';
    $('endText').textContent = (m.escaped.length ? `Went home: ${m.escaped.join(', ')}. ` : '') + (m.kept.length ? `Kept back: ${m.kept.join(', ')}. ` : '') + `Time: ${Math.floor(m.time / 60)}m ${m.time % 60}s.`;
    return;
  }
  onEvent(m);
});

function endGame() {
  $('end').classList.add('hidden');
  showLobby();
}

net.on('snap', (m) => {
  S.snap = m;
  S.me = m.p.find(p => p.id === S.myId) || null;
  world.applySnapshot(m, S.myId);
  if (S.me && S.holding && !S.me.hold && S.me.caught !== null) S.holding = null;
});
net.on('correct', (m) => { S.x = m.x; S.z = m.z; });
net.on('holdDone', () => { S.holding = null; });
net.on('toast', (m) => toast(m.text));
net.on('tannoy', (m) => tannoy(m.line));

// ---- input ---------------------------------------------------------------

canvas.addEventListener('click', () => S.phase === 'game' && canvas.requestPointerLock());
$('resume').addEventListener('click', () => { sound.resume(); canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  S.locked = document.pointerLockElement === canvas;
  $('resume').classList.toggle('hidden', S.locked || S.phase !== 'game');
  if (!S.locked) { S.keys.clear(); releaseHold(); setRadio(false); }
});
document.addEventListener('mousemove', (e) => {
  if (!S.locked) return;
  S.yaw -= e.movementX * 0.0022;
  S.pitch = clamp(S.pitch - e.movementY * 0.0022, -1.35, 1.35);
});
document.addEventListener('mousedown', (e) => { if (S.locked && e.button === 0) throwBottle(); });
document.addEventListener('keydown', (e) => {
  if (S.phase !== 'game') return;
  if (e.code === 'Tab') { e.preventDefault(); $('notebook').classList.remove('hidden'); }
  if (!S.locked || e.repeat) return;
  S.keys.add(e.code);
  switch (e.code) {
    case 'KeyE': interact(true); break;
    case 'KeyC': S.crouch = !S.crouch; break;
    case 'KeyN': S.nvOn = !S.nvOn; sound.squelch(); break;
    case 'KeyQ': throwBottle(); break;
    case 'KeyG': net.send({ t: 'act', a: 'drop' }); break;
    case 'KeyR': setRadio(true); break;
    case 'KeyM': voice.setMuted(!voice.muted); toast(voice.muted ? 'Microphone muted.' : 'Microphone on.'); break;
  }
});
document.addEventListener('keyup', (e) => {
  S.keys.delete(e.code);
  if (e.code === 'Tab') $('notebook').classList.add('hidden');
  if (e.code === 'KeyE') releaseHold();
  if (e.code === 'KeyR') setRadio(false);
});

function setRadio(on) {
  if (S.radio === on) return;
  S.radio = on;
  if (S.phase === 'game') sound.squelch();
}

function releaseHold() {
  if (S.holding) { net.send({ t: 'hold', a: S.holding, on: false }); S.holding = null; }
}

// ---- interaction -----------------------------------------------------------

function myForward() { return { x: -Math.sin(S.yaw), z: -Math.cos(S.yaw) }; }

function candidates() {
  const out = [];
  const m = world.map;
  const me = S.me;
  if (!me) return out;
  const carryKind = me.carry !== null ? world.items.get(me.carry)?.userData.kind : null;
  for (const d of m.doors) {
    const open = world.dyn.doors.get(tkey(d.x, d.z));
    out.push({ ...tileCenter(d), half: 0.9, a: 'door', x0: d.x, z0: d.z, text: open ? 'Close the door' : 'Open the door' });
  }
  for (const l of m.lockers) out.push({ ...tileCenter(l), half: 1.2, a: 'locker', x0: l.x, z0: l.z, text: 'Hide in the locker' });
  m.bells.forEach((b, i) => { if (!S.snap.bells[i]) out.push({ ...tileCenter(b), half: 1.1, a: 'bell', x0: b.x, z0: b.z, text: 'Ring the bell (everyone will hear)' }); });
  for (const [id, mesh] of world.items) {
    const u = mesh.userData;
    if (u.carrier !== null) continue;
    const text = { reel: 'Pick up the film reel', bottle: 'Pick up the bottle', battery: 'Take the battery', key: 'Take the study key' }[u.kind];
    out.push({ x: u.x, z: u.z, half: 0, a: 'pickup', item: id, text, tight: true });
  }
  if (carryKind === 'reel') out.push({ ...tileCenter(m.projector), half: 1.1, a: 'projector', text: 'Thread the reel into the projector' });
  out.push({ ...tileCenter(m.plate), half: 0, a: 'plate', hold: true, text: 'Hold E — stand on the plate', onTop: true });
  out.push({ ...tileCenter(m.lever), half: 0.8, a: 'lever', hold: true, text: 'Hold E — pull the lever' });
  const ex = m.exits.map(tileCenter);
  out.push({ x: (ex[0].x + ex[1].x) / 2, z: ex[0].z, half: 1.3, a: 'exit', text: world.dyn.exitOpen ? 'Go home' : 'Unlock the exit' });
  return out;
}

function currentTarget() {
  if (!S.me || S.me.caught !== null || S.me.esc) return null;
  if (S.me.hid !== null) return { a: 'locker', text: 'Leave the locker', x0: S.me.hid % W, z0: Math.floor(S.me.hid / W) };
  const f = myForward();
  let best = null, bestScore = Infinity;
  for (const c of candidates()) {
    const dx = c.x - S.x, dz = c.z - S.z;
    const dist = Math.hypot(dx, dz);
    const reach = Math.max(0, dist - c.half);
    if (c.onTop) {
      if (dist > 1.1) continue;
      const score = -1;
      if (score < bestScore) { best = c; bestScore = score; }
      continue;
    }
    if (reach > PLAYER.interactRange) continue;
    const dot = dist > 0.01 ? (dx * f.x + dz * f.z) / dist : 1;
    if (dot < (c.tight ? 0.8 : 0.45) && reach > 0.4) continue;
    if (!c.tight && !lineOfSight(S.x, S.z, c.x - Math.sign(dx) * c.half * 0.9, c.z - Math.sign(dz) * c.half * 0.9, world.dyn)) continue;
    const score = reach - dot * 1.5;
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function interact(pressed) {
  const t = currentTarget();
  if (!t) return;
  if (t.hold) {
    S.holding = t.a;
    net.send({ t: 'hold', a: t.a, on: true });
    return;
  }
  const msg = { t: 'act', a: t.a };
  if (t.x0 !== undefined) { msg.x = t.x0; msg.z = t.z0; }
  if (t.item !== undefined) msg.item = t.item;
  net.send(msg);
}

function throwBottle() {
  if (!S.me || S.me.bottle === null || S.me.hid !== null || S.me.caught !== null) return;
  const f = myForward();
  const range = clamp(10 + S.pitch * 10, 4, 16);
  let tx = S.x, tz = S.z;
  for (let d = 0.5; d <= range; d += 0.25) {
    const x = S.x + f.x * d, z = S.z + f.z * d;
    const t = toTile(x, z);
    if (isSolidTile(t.x, t.z, world.dyn)) break;
    tx = x; tz = z;
  }
  net.send({ t: 'throw', x: tx, z: tz });
}

// ---- HUD -----------------------------------------------------------------

let toastT = 0;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

let subT = 0;
let voiceGB = null;
function pickVoice() {
  const vs = speechSynthesis?.getVoices?.() || [];
  voiceGB = vs.find(v => /en-GB/i.test(v.lang) && /male|daniel|george|arthur|oliver/i.test(v.name))
    || vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
}
if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function tannoy(line) {
  sound.chime();
  setTimeout(() => {
    $('subtitle').textContent = line;
    $('subtitle').classList.add('show');
    clearTimeout(subT);
    subT = setTimeout(() => $('subtitle').classList.remove('show'), 1500 + line.length * 65);
    if (window.speechSynthesis) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(line);
      if (voiceGB) u.voice = voiceGB;
      u.rate = 0.92; u.pitch = 1.15; u.volume = 0.85;
      speechSynthesis.speak(u);
    }
  }, 1300);
}

let bannerT = 0;
function banner(text, ms = 2500) {
  $('banner').textContent = text;
  $('banner').classList.remove('hidden');
  clearTimeout(bannerT);
  bannerT = setTimeout(() => $('banner').classList.add('hidden'), ms);
}

function updateHud() {
  const me = S.me, snap = S.snap;
  if (!me || !snap) return;
  const t = S.locked ? currentTarget() : null;
  let prompt = t ? `[E] ${t.text}` : '';
  if (me.bottle !== null && !prompt) prompt = '[Q] Throw the bottle';
  if (me.caught !== null) prompt = 'Caged. Shout for help — someone can pull the lever.';
  if (me.esc) prompt = 'You went home. Watching the others…';
  if (me.hold === 'plate') prompt = 'Standing on the plate. The gate is open while you stay.';
  $('prompt').textContent = prompt;
  const bat = me.bat;
  $('battery').querySelector('i').style.width = `${Math.round(bat * 100)}%`;
  $('battery').classList.toggle('low', bat < 0.25);
  $('battery').querySelector('span').textContent = S.nvOn ? 'NV' : 'NV off';
  const carryKind = me.carry !== null ? world.items.get(me.carry)?.userData.kind : null;
  const carry = [carryKind && ({ reel: 'film reel', key: 'study key' }[carryKind] || carryKind), me.bottle !== null && 'bottle'].filter(Boolean);
  $('carry').textContent = carry.length ? `Carrying: ${carry.join(', ')}` : '';
  $('mic').textContent = voice.status !== 'on' ? 'No mic' : voice.muted ? 'Mic muted' : S.radio ? '● RADIO' : voice.level > 0.15 ? '● talking (it can hear you)' : 'Mic on';
  $('mic').classList.toggle('on', S.radio || voice.level > 0.15);
  const showHold = me.hold === 'lever';
  $('hold').classList.toggle('show', showHold);
  if (showHold) $('hold').querySelector('i').style.width = `${Math.round(snap.lever * 100)}%`;
  const bells = snap.bells.filter(Boolean).length;
  const keyItem = snap.items.find(i => i.k === 'key');
  const tasks = [
    [`Ring the chapel bells (${bells}/4)`, bells === 4],
    [`Return the film reels to the projector (${snap.reels}/3)`, snap.reels === 3],
    ['Stand on the plate to raise the study gate', snap.gate === 1 || !keyItem || keyItem.c !== null],
    ['Fetch the study key', !keyItem || keyItem.c !== null],
    ['Unlock the exit and go home', !!snap.exit],
  ];
  $('tasks').innerHTML = tasks.map(([t, d]) => `<li class="${d ? 'done' : ''}">${t}</li>`).join('');
}

// ---- events from the server ----------------------------------------------

function heardFrom(x, z) { return !lineOfSight(camera.position.x, camera.position.z, x, z, world.dyn); }

function onEvent(m) {
  const meId = S.myId;
  switch (m.e) {
    case 'door': {
      const c = tileCenter({ x: m.x, z: m.z });
      sound.door(c, m.open, heardFrom(c.x, c.z) && m.open === false);
      break;
    }
    case 'bell':
      world.ringBell(m.i);
      sound.bell(m);
      if (Math.hypot(m.x - S.x, m.z - S.z) < 10) nv.flash = 0.25;
      break;
    case 'throw': {
      const mesh = world.itemMesh('bottle');
      scene.add(mesh);
      S.bottles.push({ mesh, x: m.x, z: m.z, tx: m.tx, tz: m.tz, t: 0, dur: m.delay });
      break;
    }
    case 'smash': sound.smash(m, heardFrom(m.x, m.z)); break;
    case 'locker': sound.locker(m, heardFrom(m.x, m.z)); break;
    case 'lockerCheck': sound.locker(m, false); sound.clank(m); break;
    case 'caught':
      if (m.id === meId) {
        sound.caught();
        banner('CORRECTION', 3000);
        S.fade = 1; nv.flash = 0.8;
        releaseHold();
      } else {
        const name = S.names.get(m.id) || 'Someone';
        sound.noiseBurst(sound.spatial(m.x, 1.5, m.z, { refDistance: 6 }).input, { dur: 0.9, freq: 900, q: 2, type: 'bandpass', gain: 0.9 });
        toast(`${name} was taken to Correction.`);
      }
      break;
    case 'freed':
      sound.clank(tileCenter(world.map.lever));
      if (m.ids.includes(meId)) { toast('The cage swings open. Go!'); nv.flash = 0.3; }
      break;
    case 'gate': sound.clank(tileCenter(world.map.gates[0])); sound.hum(tileCenter(world.map.plate), m.open); break;
    case 'lever': sound.clank(tileCenter(world.map.lever)); break;
    case 'projector': sound.projector(tileCenter(world.map.projector)); break;
    case 'exit': { const c = tileCenter(world.map.exits[0]); sound.clank(c); sound.door(c, true, false); break; }
    case 'escaped':
      if (m.id === meId) { banner('YOU WENT HOME', 3000); S.fade = 1; }
      else toast(`${S.names.get(m.id) || 'Someone'} went home.`);
      break;
    case 'lights':
      if (!m.on) { sound.tone(sound.master, { freq: 120, dur: 2.5, gain: 0.3, type: 'sawtooth', glide: 0.25 }); toast('The lanterns are out.'); }
      break;
    case 'prefect':
      S.lastPrefectState = m.s;
      break;
  }
}

// ---- main loop -------------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  S.time += dt;
  if (S.phase === 'game' && S.snap) gameFrame(dt);
  else lobbyFrame(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function eyePass() {
  return { ir: irLight, ambient: world.ambient, ambientLevel: world.lightsOn === false ? TUNE.darkAdapt * 0.5 : TUNE.darkAdapt };
}

function lobbyFrame(dt) {
  // Slow drift down the corridor behind the lobby card.
  const t = S.time * 0.05;
  camera.position.set(4 * TILE + (Math.sin(t) * 0.5 + 0.5) * 30 * TILE, 1.6, 9 * TILE);
  camera.rotation.set(Math.sin(S.time * 0.13) * 0.05, -Math.PI / 2 + Math.sin(S.time * 0.07) * 0.6, 0);
  irLight.intensity = TUNE.irPower;
  world.update(dt, [], null, S.myId, S.time);
  nv.render(scene, camera, world.lights, dt, { nvOn: 1, battery: 1, fear: 0, locker: false, caught: false, fade: 0 }, eyePass());
  voice.update('lobby', new Map());
}

function gameFrame(dt) {
  const me = S.me;
  const snap = S.snap;
  if (!me) { nv.render(scene, camera, world.lights, dt, { nvOn: 1, battery: 1, fear: 0, fade: 1 }); return; }

  const hidden = me.hid !== null, caught = me.caught !== null, escaped = !!me.esc;
  const canMove = S.locked && !hidden && !caught && !escaped && !S.holding && !me.hold;

  // --- movement ---
  let mx = 0, mz = 0;
  if (canMove) {
    const k = S.keys;
    const f = myForward();
    const r = { x: -f.z, z: f.x };
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const str = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    mx = f.x * fwd + r.x * str; mz = f.z * fwd + r.z * str;
  }
  const len = Math.hypot(mx, mz);
  const crouching = S.crouch || S.keys.has('ControlLeft');
  const wantRun = S.keys.has('ShiftLeft') || S.keys.has('ShiftRight');
  S.moving = len > 0;
  S.running = S.moving && wantRun && !crouching && S.stamina > 0.02;
  if (S.running) S.stamina = Math.max(0, S.stamina - dt / PLAYER.staminaSeconds);
  else S.stamina = Math.min(1, S.stamina + dt * (S.moving ? 0.12 : 0.25));
  S.exhausted += ((S.stamina < 0.35 ? 1 - S.stamina : 0) - S.exhausted) * Math.min(1, dt * 1.5);
  if (len > 0) {
    const speed = S.running ? PLAYER.run : crouching ? PLAYER.crouch : PLAYER.walk;
    const nx = S.x + (mx / len) * speed * dt, nz = S.z + (mz / len) * speed * dt;
    const c = collideCircle(nx, nz, PLAYER.radius, world.dyn);
    const moved = Math.hypot(c.x - S.x, c.z - S.z);
    S.x = c.x; S.z = c.z;
    S.stepAcc += moved;
    S.bob += moved * 3.2;
    const stride = S.running ? 2.0 : crouching ? 1.1 : 1.6;
    if (S.stepAcc > stride) {
      S.stepAcc = 0;
      sound.footstep(null, { self: true, volume: S.running ? 1 : crouching ? 0.15 : 0.6 });
      if (!crouching) net.send({ t: 'noise', kind: S.running ? 'run' : 'walk' });
    }
  }

  // Walk out of the open exit to go home.
  if (snap.exit && !escaped && !S.sentEscape) {
    const ex = world.map.exits.map(tileCenter);
    if (ex.some(c => Math.hypot(c.x - S.x, c.z - S.z) < TILE * 0.9)) { S.sentEscape = true; net.send({ t: 'act', a: 'exit' }); }
  }

  // --- camera ---
  const eyeTarget = crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
  S.eye += (eyeTarget - S.eye) * Math.min(1, dt * 8);
  let camX = S.x, camZ = S.z, camY = S.eye + (S.moving ? Math.sin(S.bob) * (S.running ? 0.06 : 0.03) : 0);
  let camYaw = S.yaw, camPitch = S.pitch;
  if (hidden) {
    const lt = { x: me.hid % W, z: Math.floor(me.hid / W) };
    const lc = tileCenter(lt);
    // Face out of the open side of the locker bank nearest to where we were.
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => !isSolidTile(lt.x + dx, lt.z + dz, world.dyn));
    sides.sort((a, b) => Math.hypot(lc.x + a[0] * TILE - S.x, lc.z + a[1] * TILE - S.z) - Math.hypot(lc.x + b[0] * TILE - S.x, lc.z + b[1] * TILE - S.z));
    const [dx, dz] = sides[0] || [0, 1];
    camX = lc.x + dx * (TILE * 0.36); camZ = lc.z + dz * (TILE * 0.36); camY = 1.55;
    const face = Math.atan2(-dx, -dz);
    const off = clamp(angleDiff(S.yaw, face), -0.5, 0.5);
    S.yaw = face + off;
    camYaw = S.yaw; camPitch = clamp(S.pitch, -0.3, 0.3);
  } else if (escaped) {
    const others = snap.p.filter(p => p.id !== S.myId && p.caught === null && !p.esc);
    const w = others[0] && world.players.get(others[0].id);
    if (w) { camX = w.x; camZ = w.z; camY = 1.6; camYaw = w.yaw - Math.PI; camPitch = others[0].pitch || 0; }
  } else if (caught) {
    camY = 1.55;
  }
  camera.position.set(camX, camY, camZ);
  camera.rotation.set(camPitch, camYaw, 0);
  S.camX = camX; S.camZ = camZ;

  // --- send state ---
  S.sendIn -= dt;
  if (S.sendIn <= 0) {
    S.sendIn = 1 / TICK_HZ;
    net.send({ t: 'state', x: +S.x.toFixed(3), z: +S.z.toFixed(3), yaw: S.yaw + Math.PI, pitch: S.pitch, crouch: crouching, moving: S.moving, running: S.running, radio: S.radio, nv: S.nvOn && me.bat > 0 });
  }
  // Voice: talking makes noise the Prefect can hear.
  const lvl = voice.readLevel();
  S.talkIn -= dt;
  if (S.talkIn <= 0 && lvl > 0.15 && !caught && !escaped) { S.talkIn = 0.4; net.send({ t: 'noise', kind: 'talk', level: lvl }); }
  S.radioIn -= dt;
  if (S.radio && S.radioIn <= 0) { S.radioIn = 1; net.send({ t: 'noise', kind: 'radio' }); }

  // --- world & others ---
  world.update(dt, snap.p, snap.f, S.myId, S.time);
  const remotes = new Map();
  for (const p of snap.p) {
    if (p.id === S.myId) continue;
    const a = world.players.get(p.id);
    if (!a) continue;
    const muffled = !lineOfSight(camX, camZ, a.x, a.z, world.dyn);
    remotes.set(p.id, { x: a.x, z: a.z, muffled, radio: !!p.radio, inLocker: p.hid !== null, escaped: !!p.esc });
    // Their footsteps.
    const st = S.remoteSteps.get(p.id) || { acc: 0, x: a.x, z: a.z, radio: 0 };
    st.acc += Math.hypot(a.x - st.x, a.z - st.z); st.x = a.x; st.z = a.z;
    const stride = p.r ? 2.0 : p.c ? 1.1 : 1.6;
    if (st.acc > stride && p.hid === null) { st.acc = 0; if (!p.c) sound.footstep(a, { volume: p.r ? 1 : 0.6, muffled }); }
    if (st.radio !== p.radio) { st.radio = p.radio; if (p.radio || st.radio === 0) sound.squelch(); }
    S.remoteSteps.set(p.id, st);
  }
  voice.update('game', remotes);

  // Bottles in flight.
  S.bottles = S.bottles.filter(b => {
    b.t += dt;
    const k = Math.min(1, b.t / b.dur);
    b.mesh.position.set(b.x + (b.tx - b.x) * k, 1.4 + Math.sin(k * Math.PI) * 1.5 - k * 1.2, b.z + (b.tz - b.z) * k);
    b.mesh.rotation.x += dt * 12;
    if (k >= 1) { scene.remove(b.mesh); return false; }
    return true;
  });

  // --- the Prefect, as you experience it ---
  const f = world.prefect;
  const pd = Math.hypot(f.x - camX, f.z - camZ);
  const pLOS = lineOfSight(camX, camZ, f.x, f.z, world.dyn);
  S.prefectStep += (f.speed || 0) * dt;
  if (S.prefectStep > 1.5) { S.prefectStep = 0; sound.footstep(f, { heavy: true, volume: f.state === 'chase' ? 1.2 : 0.8, muffled: !pLOS }); }
  S.prefectBreathIn -= dt;
  if (S.prefectBreathIn <= 0) { S.prefectBreathIn = 2.5 + Math.random() * 2; if (pd < 14) sound.prefectBreath(f, !pLOS); }
  const chasing = f.state === 'chase';
  let fear = 0;
  if (chasing && pd < 22) fear = Math.max(fear, 1 - pd / 22);
  if (pLOS && pd < 12) fear = Math.max(fear, 0.35 * (1 - pd / 12) + (chasing ? 0.3 : 0));
  if (caught) fear = 0.2;
  S.fear = fear;
  if (chasing && S.lastStingState !== 'chase' && pLOS && pd < 18) { sound.sting(); }
  S.lastStingState = f.state;

  // Ambient creaks.
  S.creakIn -= dt;
  if (S.creakIn <= 0) { S.creakIn = 10 + Math.random() * 25; sound.creak(); }

  // --- audio listener & beds ---
  sound.setListener(camX, camY, camZ, camYaw);
  sound.updateBeds(dt, {
    fear, exhaustion: S.exhausted, chasing: chasing && pd < 30,
    inLocker: hidden, prefectNear: clamp(1 - pd / 10, 0, 1),
  });

  // --- night vision & render ---
  const batteryDead = me.bat <= 0.001;
  let nvOn = S.nvOn && !batteryDead ? 1 : 0;
  if (nvOn && me.bat < 0.12 && Math.random() < 0.08) nvOn = 0; // dying battery stutters
  irLight.intensity = nvOn ? TUNE.irPower : 0;
  S.fade = Math.max(0, S.fade - dt * 0.7);
  nv.render(scene, camera, world.lights, dt, {
    nvOn, battery: me.bat, fear, locker: hidden, caught, fade: escaped && !remotes.size ? 0.9 : S.fade,
  }, eyePass());
  updateHud();
}

// Debug handle for testing in the browser console: __programme.S, __programme.world
window.__programme = { S, world, net, voice, sound, nv, TUNE };
