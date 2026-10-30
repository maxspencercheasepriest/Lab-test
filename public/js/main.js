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
import { Arms } from './arms.js';

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

// The pupil's own infrared illuminator (only lights the world in *your* goggles).
const irLight = new THREE.PointLight(0xffffff, 0, 22, 1.0);
const TUNE = { irPower: 40, darkAdapt: 0.25 };
camera.add(irLight);

const world = new World(scene, makeTextures());
world.lights.push(irLight);
const nv = new NightVision(renderer);
const arms = new Arms((k) => world.itemMesh(k));

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  arms.setAspect(w / h);
  nv.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---- state ---------------------------------------------------------------

const net = new Net();
const sound = new Sound();
const voice = new Voice(net, sound);

const S = {
  phase: 'lobby',
  myId: null, host: null, names: new Map(),
  snap: null, me: null,
  x: 0, z: 0, yaw: 0, pitch: 0, eye: PLAYER.eyeHeight,
  crouch: false, stamina: 1, exhausted: 0, stepAcc: 0, bob: 0, moving: false, running: false,
  nvOn: true, holding: null, sentEscape: false,
  keys: new Set(), locked: false,
  sendIn: 0, talkIn: 0, radioIn: 0, radio: false,
  remoteSteps: new Map(), enemyAudio: new Map(),
  fear: 0, time: 0, creakIn: 12, fade: 0, thrown: [],
  lastHp: 100, sway: { x: 0, y: 0 }, tasksDone: new Map(), shake: 0, lastChased: 0,
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
  world.clearEnemies();
  document.exitPointerLock?.();
}

// ---- lesson start / end --------------------------------------------------

net.on('start', (m) => {
  S.phase = 'game';
  S.snap = null; S.me = null;
  const me = m.players.find(p => p.id === S.myId);
  S.x = me.x; S.z = me.z; S.yaw = Math.PI; S.pitch = 0;
  Object.assign(S, { crouch: false, stamina: 1, holding: null, sentEscape: false, nvOn: true, fade: 1, lastHp: 100, tasksDone: new Map() });
  for (const id of [...world.players.keys()]) world.removeAvatar(id);
  for (const p of m.players) if (p.id !== S.myId) world.makeAvatar(p.id, p.name);
  world.clearEnemies();
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

function endGame() { $('end').classList.add('hidden'); showLobby(); }

net.on('snap', (m) => {
  S.snap = m;
  S.me = m.p.find(p => p.id === S.myId) || null;
  world.applySnapshot(m, S.myId);
  if (S.me && S.holding && !S.me.hold && (S.me.caught !== null || S.me.dn || S.me.gr >= 0)) S.holding = null;
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
  S.sway.x = clamp(S.sway.x + e.movementX * 0.00006, -0.02, 0.02);
  S.sway.y = clamp(S.sway.y - e.movementY * 0.00006, -0.02, 0.02);
});
document.addEventListener('mousedown', (e) => { if (S.locked && e.button === 0) throwIt(); });
document.addEventListener('keydown', (e) => {
  if (S.phase !== 'game') return;
  if (e.code === 'Tab') { e.preventDefault(); $('keys').classList.remove('hidden'); }
  if (!S.locked || e.repeat) return;
  S.keys.add(e.code);
  const grabbed = S.me && S.me.gr >= 0;
  if (grabbed && (e.code === 'KeyE' || e.code === 'Space')) { net.send({ t: 'struggle' }); sound.struggle(); S.shake = 0.6; return; }
  switch (e.code) {
    case 'KeyE': interact(); break;
    case 'KeyC': S.crouch = !S.crouch; break;
    case 'KeyN': S.nvOn = !S.nvOn; sound.squelch(); break;
    case 'KeyQ': throwIt(); break;
    case 'KeyF': if (S.me?.sy > 0) net.send({ t: 'act', a: 'heal' }); else toast('No syringes.'); break;
    case 'KeyG': net.send({ t: 'act', a: 'drop' }); break;
    case 'KeyR': setRadio(true); break;
    case 'KeyM': voice.setMuted(!voice.muted); toast(voice.muted ? 'Microphone muted.' : 'Microphone on.'); break;
  }
});
document.addEventListener('keyup', (e) => {
  S.keys.delete(e.code);
  if (e.code === 'Tab') $('keys').classList.add('hidden');
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

const ITEM_TEXT = {
  reel: 'Pick up the film reel', bottle: 'Pick up the bottle', brick: 'Pick up the brick',
  battery: 'Take the battery', key: 'Take the study key', syringe: 'Take the syringe',
};

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
  for (const h of m.hides) out.push({ ...tileCenter(h), half: 1.1, a: 'hide', x0: h.x, z0: h.z, text: h.kind === 'bed' ? 'Hide under the bed' : 'Hide in the locker' });
  m.bells.forEach((b, i) => { if (!S.snap.bells[i]) out.push({ ...tileCenter(b), half: 1.1, a: 'bell', x0: b.x, z0: b.z, text: 'Ring the bell (everyone will hear)' }); });
  for (const [id, mesh] of world.items) {
    const u = mesh.userData;
    if (u.carrier !== null) continue;
    out.push({ x: u.x, z: u.z, half: 0, a: 'pickup', item: id, text: ITEM_TEXT[u.kind] || 'Pick up', tight: true });
  }
  if (carryKind === 'reel') out.push({ ...tileCenter(m.projector), half: 1.1, a: 'projector', text: 'Thread the reel into the projector' });
  out.push({ ...tileCenter(m.plate), half: 0, a: 'plate', hold: true, text: 'Hold E — stand on the plate', onTop: true });
  out.push({ ...tileCenter(m.lever), half: 0.8, a: 'lever', hold: true, text: 'Hold E — pull the lever' });
  const ex = m.exits.map(tileCenter);
  out.push({ x: (ex[0].x + ex[1].x) / 2, z: ex[0].z - TILE * 0.6, half: 1.3, a: 'exit', text: world.dyn.exitOpen ? 'Go home' : 'Unlock the exit' });
  // Downed friends.
  for (const p of S.snap.p) {
    if (p.id === S.myId || !p.dn) continue;
    const a = world.players.get(p.id);
    if (a) out.push({ x: a.x, z: a.z, half: 0.4, a: 'revive', target: p.id, hold: true, text: `Hold E — help ${S.names.get(p.id) || 'them'} up`, priority: true });
  }
  return out;
}

function currentTarget() {
  const me = S.me;
  if (!me || me.caught !== null || me.esc || me.dn || me.gr >= 0) return null;
  if (me.hid !== null) return { a: 'hide', text: me.hk === 'bed' ? 'Crawl out' : 'Leave the locker', x0: me.hid % W, z0: Math.floor(me.hid / W) };
  const f = myForward();
  let best = null, bestScore = Infinity;
  for (const c of candidates()) {
    const dx = c.x - S.x, dz = c.z - S.z;
    const dist = Math.hypot(dx, dz);
    const reach = Math.max(0, dist - c.half);
    if (c.onTop) {
      if (dist > 1.1) continue;
      if (-1 < bestScore) { best = c; bestScore = -1; }
      continue;
    }
    if (reach > PLAYER.interactRange) continue;
    const dot = dist > 0.01 ? (dx * f.x + dz * f.z) / dist : 1;
    if (dot < (c.tight ? 0.8 : 0.45) && reach > 0.4) continue;
    if (!c.tight && !lineOfSight(S.x, S.z, c.x - Math.sign(dx) * c.half * 0.9, c.z - Math.sign(dz) * c.half * 0.9, world.dyn)) continue;
    const score = reach - dot * 1.5 - (c.priority ? 3 : 0);
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function interact() {
  const t = currentTarget();
  if (!t) return;
  if (t.hold) {
    S.holding = t.a;
    net.send({ t: 'hold', a: t.a, on: true, target: t.target });
    return;
  }
  const msg = { t: 'act', a: t.a };
  if (t.x0 !== undefined) { msg.x = t.x0; msg.z = t.z0; }
  if (t.item !== undefined) msg.item = t.item;
  if (t.a !== 'hide' || S.me.hid === null) arms.reach();
  net.send(msg);
}

function throwIt() {
  const me = S.me;
  if (!me || me.th === null || me.hid !== null || me.caught !== null || me.dn || me.gr >= 0) return;
  const f = myForward();
  const range = clamp(10 + S.pitch * 10, 4, 16);
  let tx = S.x, tz = S.z;
  for (let d = 0.5; d <= range; d += 0.25) {
    const x = S.x + f.x * d, z = S.z + f.z * d;
    const t = toTile(x, z);
    if (isSolidTile(t.x, t.z, world.dyn)) break;
    tx = x; tz = z;
  }
  arms.throwIt();
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

function setBar(el, v) { el.querySelector('i').style.width = `${Math.round(clamp(v, 0, 1) * 100)}%`; }

function renderTasks(snap, me) {
  const bells = snap.bells.filter(Boolean).length;
  const ready = bells === 4 && snap.reels === 3 && snap.keyTaken;
  const tasks = [
    ['bells', `Ring the chapel bells`, `${bells}/4 — everybody will hear`, bells === 4],
    ['reels', `Return the film reels to the projector`, `${snap.reels}/3 — they're hidden somewhere new every Lesson`, snap.reels === 3],
    ['gate', `Raise the study gate`, `Someone stands on the plate in the Old Classroom`, !!snap.keyTaken || !!snap.gate],
    ['key', `Take the key from the study`, '', !!snap.keyTaken],
    ['exit', `Unlock the exit in the Entrance Hall`, ready || snap.exit ? '' : 'Needs the bells, reels and key', !!snap.exit, !ready && !snap.exit],
    ['home', `Go home`, '', !!me.esc, !snap.exit],
  ];
  let html = '';
  for (const [id, text, sub, done, locked] of tasks) {
    const was = S.tasksDone.get(id);
    let just = false;
    if (done && was === false) { just = true; sound.chimeTick?.(); }
    if (done !== was) S.tasksDone.set(id, done);
    if (just) S[`just_${id}`] = S.time + 1.6;
    const cls = [done ? 'done' : '', locked ? 'locked' : '', (S[`just_${id}`] || 0) > S.time ? 'just' : ''].join(' ');
    html += `<li class="${cls}">${text}${sub && !done ? `<span class="sub">${sub}</span>` : ''}</li>`;
  }
  if (html !== S.tasksHtml) { $('tasks').innerHTML = html; S.tasksHtml = html; }
}

function updateHud() {
  const me = S.me, snap = S.snap;
  if (!me || !snap) return;
  renderTasks(snap, me);

  const t = S.locked ? currentTarget() : null;
  let prompt = t ? `[E] ${t.text}` : '';
  if (!prompt && me.th !== null && me.hid === null) prompt = `[Q] Throw the ${world.items.get(me.th)?.userData.kind || 'bottle'}`;
  if (me.caught !== null) prompt = 'Caged in Correction. Shout for help — someone can pull the lever.';
  if (me.esc) prompt = 'You went home. Watching the others…';
  if (me.hold === 'plate') prompt = 'Standing on the plate. The gate stays open while you stay.';
  if (me.gr >= 0 || me.dn) prompt = '';
  $('prompt').textContent = prompt;

  // Health, battery, inventory.
  setBar($('health'), me.hp / PLAYER.maxHealth);
  $('health').classList.toggle('low', me.hp < 35);
  setBar($('battery'), me.bat);
  $('battery').classList.toggle('low', me.bat < 0.25);
  $('battery').querySelector('span').textContent = S.nvOn ? 'NV' : 'NV off';
  const carryKind = me.carry !== null ? world.items.get(me.carry)?.userData.kind : null;
  const thKind = me.th !== null ? world.items.get(me.th)?.userData.kind : null;
  const inv = [];
  if (carryKind) inv.push({ reel: 'film reel', key: 'study key' }[carryKind] || carryKind);
  if (thKind) inv.push(`${thKind} [Q]`);
  if (me.sy) inv.push(`${me.sy} syringe${me.sy > 1 ? 's' : ''} [F]`);
  $('inv').textContent = inv.join(' · ');
  $('mic').textContent = voice.status !== 'on' ? 'No mic' : voice.muted ? 'Mic muted' : S.radio ? '● RADIO' : voice.level > 0.45 ? '● shouting — they can hear you' : voice.level > 0.15 ? '● talking (quietly)' : 'Mic on';
  $('mic').classList.toggle('on', S.radio || voice.level > 0.15);

  // The eye: how close the staff are to noticing you.
  const eye = $('eye');
  const sus = me.sus || 0;
  eye.style.opacity = me.ch ? 1 : sus > 0.05 ? 0.35 + sus * 0.65 : 0;
  eye.classList.toggle('alert', !!me.ch);
  $('eyePupil').setAttribute('r', String(2 + sus * 7));
  $('eyeOutline').setAttribute('d', `M2 16 Q32 ${16 - 6 - sus * 16} 62 16 Q32 ${16 + 6 + sus * 16} 2 16 Z`);

  // Centre panels.
  const grabbed = me.gr >= 0;
  $('struggle').classList.toggle('hidden', !grabbed);
  if (grabbed) {
    setBar($('struggle').querySelector('.bar'), me.gr);
    setBar($('struggle').querySelector('.time'), me.grT / 2.8);
  }
  $('downedBox').classList.toggle('hidden', !me.dn);
  if (me.dn) {
    const helper = snap.p.find(p => p.revT === S.myId);
    $('bleed').textContent = helper ? `${S.names.get(helper.id) || 'Someone'} is helping you up…` : `Bleeding out: ${Math.ceil(me.bleed)}s`;
  }
  let prog = null;
  if (me.hold === 'lever') prog = ['Pulling the lever…', snap.lever];
  else if (me.hold === 'revive') prog = [`Helping ${S.names.get(me.revT) || 'them'} up…`, me.rev];
  else if (me.heal > 0) prog = ['Injecting…', me.heal];
  else if (me.dn) { const h = snap.p.find(p => p.revT === S.myId); if (h) prog = ['Getting up…', h.rev]; }
  $('progress').classList.toggle('hidden', !prog);
  if (prog) { $('progressLabel').textContent = prog[0]; setBar($('progress'), prog[1]); }
}

// ---- events from the server ----------------------------------------------

function heardFrom(x, z) { return !lineOfSight(camera.position.x, camera.position.z, x, z, world.dyn); }

function onEvent(m) {
  const meId = S.myId;
  switch (m.e) {
    case 'door': {
      const c = tileCenter({ x: m.x, z: m.z });
      sound.door(c, m.open, heardFrom(c.x, c.z));
      break;
    }
    case 'slam': {
      const c = tileCenter({ x: m.x, z: m.z });
      sound.slam(c); sound.stun(c);
      break;
    }
    case 'bell':
      world.ringBell(m.i);
      sound.bell(m);
      if (Math.hypot(m.x - S.x, m.z - S.z) < 10) nv.flash = 0.25;
      break;
    case 'throw': {
      const mesh = world.itemMesh(m.k || 'bottle');
      scene.add(mesh);
      S.thrown.push({ mesh, x: m.x, z: m.z, tx: m.tx, tz: m.tz, t: 0, dur: m.delay });
      if (m.id !== meId) sound.swing(m, false);
      break;
    }
    case 'smash': if (m.k === 'brick') sound.slam(m); else sound.smash(m, heardFrom(m.x, m.z)); break;
    case 'stun': sound.stun(m); if (Math.hypot(m.x - S.x, m.z - S.z) < 12) toast('Stunned!'); break;
    case 'glass': sound.glass(m, Math.hypot(m.x - S.x, m.z - S.z) < 0.5, heardFrom(m.x, m.z)); break;
    case 'hide': (m.kind === 'bed' ? sound.bed(m, heardFrom(m.x, m.z)) : sound.locker(m, heardFrom(m.x, m.z))); break;
    case 'hideCheck': (m.kind === 'bed' ? sound.bed(m, false) : sound.locker(m, false)); sound.clank(m); break;
    case 'windup': sound.windup(m); break;
    case 'swing': world.swing(m.e); sound.swing(m, false); break;
    case 'hit':
      if (m.id === meId) { sound.swing(m, true); nv.hit = 1; S.shake = 1; arms.flinch(); }
      else sound.noiseBurst(sound.spatial(m.x, 1.2, m.z, { refDistance: 3 }).input, { dur: 0.3, freq: 250, gain: 1.0 });
      break;
    case 'grab':
      if (m.id === meId) { sound.grab(); nv.hit = 0.7; banner('STRUGGLE!', 1200); }
      else { sound.noiseBurst(sound.spatial(m.x, 1.5, m.z, { refDistance: 6 }).input, { dur: 0.9, freq: 900, q: 2, type: 'bandpass', gain: 0.9 }); toast(`${S.names.get(m.id) || 'Someone'} has been grabbed! Throw something at it!`); }
      break;
    case 'released':
      if (m.newEnemy) { sound.newEnemy(); break; }
      if (m.id === meId) { nv.flash = 0.2; toast(m.struggled ? 'You wrenched free. RUN.' : 'It let go — RUN!'); }
      break;
    case 'downed':
      if (m.id === meId) { sound.downed(); banner('DOWN', 2000); releaseHold(); }
      else toast(`${S.names.get(m.id) || 'Someone'} is down! Help them up.`);
      break;
    case 'revived':
      if (m.id === meId) { toast('Back on your feet.'); nv.flash = 0.15; }
      break;
    case 'heal': if (m.id === meId) sound.inject(); break;
    case 'healed': if (m.id === meId) toast('That\'s better.'); break;
    case 'caught':
      if (m.id === meId) {
        sound.caught();
        banner('CORRECTION', 3000);
        S.fade = 1; nv.flash = 0.8;
        releaseHold();
      } else toast(`${S.names.get(m.id) || 'Someone'} was taken to Correction.`);
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
    case 'hunt': toast('The staff are doing their rounds.'); break;
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
  return { ir: irLight, ambient: world.ambient, ambientLevel: world.lightsOn ? TUNE.darkAdapt : TUNE.darkAdapt * 0.4 };
}

function lobbyFrame(dt) {
  const t = S.time * 0.05;
  camera.position.set(4 * TILE + (Math.sin(t) * 0.5 + 0.5) * 34 * TILE, 1.6, 10 * TILE);
  camera.rotation.set(Math.sin(S.time * 0.13) * 0.05, -Math.PI / 2 + Math.sin(S.time * 0.07) * 0.6, 0);
  irLight.intensity = TUNE.irPower;
  world.update(dt, [], S.myId, S.time);
  arms.update(dt, { mode: 'hidden' });
  nv.render(scene, camera, world.lights, dt, { nvOn: 1, battery: 1, fear: 0, fade: 0 }, eyePass(), null);
  voice.update('lobby', new Map());
}

function hideCamera(me) {
  const h = { x: me.hid % W, z: Math.floor(me.hid / W) };
  const c = tileCenter(h);
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => !isSolidTile(h.x + dx, h.z + dz, world.dyn));
  sides.sort((a, b) => Math.hypot(c.x + a[0] * TILE - S.x, c.z + a[1] * TILE - S.z) - Math.hypot(c.x + b[0] * TILE - S.x, c.z + b[1] * TILE - S.z));
  const [dx, dz] = sides[0] || [0, 1];
  const bed = me.hk === 'bed';
  const face = Math.atan2(-dx, -dz);
  S.yaw = face + clamp(angleDiff(S.yaw, face), bed ? -0.7 : -0.5, bed ? 0.7 : 0.5);
  return {
    x: c.x + dx * (TILE * (bed ? 0.3 : 0.36)), z: c.z + dz * (TILE * (bed ? 0.3 : 0.36)),
    y: bed ? 0.28 : 1.55, yaw: S.yaw, pitch: clamp(S.pitch, bed ? -0.1 : -0.3, bed ? 0.15 : 0.3),
  };
}

function gameFrame(dt) {
  const me = S.me;
  const snap = S.snap;
  if (!me) { nv.render(scene, camera, world.lights, dt, { nvOn: 1, battery: 1, fear: 0, fade: 1 }, eyePass(), null); return; }

  const hidden = me.hid !== null, caught = me.caught !== null, escaped = !!me.esc;
  const downed = !!me.dn, grabbed = me.gr >= 0, healing = me.heal > 0;
  const holdingStill = S.holding === 'plate' || S.holding === 'lever' || me.hold === 'plate' || me.hold === 'lever' || me.hold === 'revive';
  const canMove = S.locked && !hidden && !caught && !escaped && !grabbed && !healing && !holdingStill;

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
  const crouching = (S.crouch || S.keys.has('ControlLeft')) && !downed;
  const wantRun = S.keys.has('ShiftLeft') || S.keys.has('ShiftRight');
  S.moving = len > 0;
  S.running = S.moving && wantRun && !crouching && !downed && S.stamina > 0.02;
  if (S.running) S.stamina = Math.max(0, S.stamina - dt / PLAYER.staminaSeconds);
  else S.stamina = Math.min(1, S.stamina + dt * (S.moving ? 0.12 : 0.25));
  S.exhausted += ((S.stamina < 0.35 ? 1 - S.stamina : 0) - S.exhausted) * Math.min(1, dt * 1.5);
  if (len > 0) {
    let speed = downed ? PLAYER.crawl : S.running ? PLAYER.run : crouching ? PLAYER.crouch : PLAYER.walk;
    if (me.hp < 35 && !downed) speed *= PLAYER.limp;
    const nx = S.x + (mx / len) * speed * dt, nz = S.z + (mz / len) * speed * dt;
    const c = collideCircle(nx, nz, PLAYER.radius, world.dyn);
    const moved = Math.hypot(c.x - S.x, c.z - S.z);
    S.x = c.x; S.z = c.z;
    S.stepAcc += moved;
    S.bob += moved * (downed ? 6 : 3.2);
    const stride = S.running ? 2.0 : crouching || downed ? 1.1 : 1.6;
    if (S.stepAcc > stride) {
      S.stepAcc = 0;
      sound.footstep(null, { self: true, volume: S.running ? 1 : crouching || downed ? 0.15 : 0.6 });
      if (!crouching && !downed) net.send({ t: 'noise', kind: S.running ? 'run' : 'walk' });
    }
  }

  if (snap.exit && !escaped && !S.sentEscape && !downed) {
    const ex = world.map.exits.map(tileCenter);
    if (ex.some(c => Math.hypot(c.x - S.x, c.z - S.z) < TILE * 0.9)) { S.sentEscape = true; net.send({ t: 'act', a: 'exit' }); }
  }

  // --- camera ---
  const eyeTarget = downed ? PLAYER.downedEyeHeight : crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
  S.eye += (eyeTarget - S.eye) * Math.min(1, dt * (downed ? 3 : 8));
  let camX = S.x, camZ = S.z, camY = S.eye + (S.moving ? Math.sin(S.bob) * (S.running ? 0.06 : 0.03) : 0);
  let camYaw = S.yaw, camPitch = S.pitch, camRoll = downed ? 0.25 : 0;
  if (hidden) {
    const h = hideCamera(me);
    camX = h.x; camZ = h.z; camY = h.y; camYaw = h.yaw; camPitch = h.pitch;
  } else if (escaped) {
    const others = snap.p.filter(p => p.id !== S.myId && p.caught === null && !p.esc);
    const w = others[0] && world.players.get(others[0].id);
    if (w) { camX = w.x; camZ = w.z; camY = 1.6; camYaw = w.yaw - Math.PI; camPitch = others[0].pitch || 0; }
  } else if (caught) {
    camY = 1.55;
  } else if (grabbed) {
    // Pulled face to face with it.
    let best = null, bd = 9;
    for (const v of world.enemies.values()) { const d = Math.hypot(v.x - S.x, v.z - S.z); if (d < bd) { bd = d; best = v; } }
    if (best) {
      const want = Math.atan2(-(best.x - S.x), -(best.z - S.z));
      S.yaw += angleDiff(want, S.yaw) * Math.min(1, dt * 6);
      S.pitch += (0.25 - S.pitch) * Math.min(1, dt * 4);
      camYaw = S.yaw; camPitch = S.pitch;
    }
  }
  S.shake = Math.max(0, S.shake - dt * 2);
  const sh = S.shake * 0.03;
  camera.position.set(camX + (Math.random() - 0.5) * sh, camY + (Math.random() - 0.5) * sh, camZ);
  camera.rotation.set(camPitch, camYaw, camRoll + (Math.random() - 0.5) * sh);

  // --- send state ---
  S.sendIn -= dt;
  if (S.sendIn <= 0) {
    S.sendIn = 1 / TICK_HZ;
    net.send({ t: 'state', x: +S.x.toFixed(3), z: +S.z.toFixed(3), yaw: S.yaw + Math.PI, pitch: S.pitch, crouch: crouching, moving: S.moving, running: S.running, radio: S.radio, nv: S.nvOn && me.bat > 0 });
  }
  const lvl = voice.readLevel();
  S.talkIn -= dt;
  if (S.talkIn <= 0 && lvl > 0.15 && !caught && !escaped) { S.talkIn = 0.4; net.send({ t: 'noise', kind: 'talk', level: lvl }); }
  S.radioIn -= dt;
  if (S.radio && S.radioIn <= 0) { S.radioIn = 1; net.send({ t: 'noise', kind: 'radio' }); }

  // --- world & others ---
  world.update(dt, snap.p, S.myId, S.time);
  const remotes = new Map();
  for (const p of snap.p) {
    if (p.id === S.myId) continue;
    const a = world.players.get(p.id);
    if (!a) continue;
    const muffled = !lineOfSight(camX, camZ, a.x, a.z, world.dyn);
    remotes.set(p.id, { x: a.x, z: a.z, muffled, radio: !!p.radio, inLocker: p.hid !== null, escaped: !!p.esc });
    const st = S.remoteSteps.get(p.id) || { acc: 0, x: a.x, z: a.z, radio: 0 };
    st.acc += Math.hypot(a.x - st.x, a.z - st.z); st.x = a.x; st.z = a.z;
    const stride = p.r ? 2.0 : p.c ? 1.1 : 1.6;
    if (st.acc > stride && p.hid === null) { st.acc = 0; if (!p.c) sound.footstep(a, { volume: p.r ? 1 : 0.6, muffled }); }
    if (st.radio !== p.radio) { st.radio = p.radio; sound.squelch(); }
    S.remoteSteps.set(p.id, st);
  }
  voice.update('game', remotes);

  S.thrown = S.thrown.filter(b => {
    b.t += dt;
    const k = Math.min(1, b.t / b.dur);
    b.mesh.position.set(b.x + (b.tx - b.x) * k, 1.4 + Math.sin(k * Math.PI) * 1.5 - k * 1.2, b.z + (b.tz - b.z) * k);
    b.mesh.rotation.x += dt * 12;
    if (k >= 1) { scene.remove(b.mesh); return false; }
    return true;
  });

  // --- the staff, as you experience them ---
  let fear = 0, chasing = false, nearest = 99;
  for (const [id, v] of world.enemies) {
    const d = Math.hypot(v.x - camX, v.z - camZ);
    nearest = Math.min(nearest, d);
    const los = lineOfSight(camX, camZ, v.x, v.z, world.dyn);
    const au = S.enemyAudio.get(id) || { step: 0, breath: 2 + Math.random() * 2, mutter: 3 + Math.random() * 6 };
    au.step += (v.speed || 0) * dt;
    const heavy = v.kind === 'prefect';
    if (au.step > (heavy ? 1.5 : 1.3)) { au.step = 0; sound.footstep(v, { heavy, volume: (v.state === 'chase' ? 1.2 : 0.8) * (heavy ? 1 : 0.75), muffled: !los }); }
    au.breath -= dt;
    if (heavy && au.breath <= 0) { au.breath = 2.5 + Math.random() * 2; if (d < 14) sound.prefectBreath(v, !los); }
    au.mutter -= dt;
    if (!heavy && au.mutter <= 0) { au.mutter = 4 + Math.random() * 7; if (d < 22 && v.state !== 'stunned') sound.mutter(v, !los); }
    S.enemyAudio.set(id, au);
    if (v.state === 'chase' || v.state === 'attack') {
      if (d < 22) { fear = Math.max(fear, 1 - d / 22); chasing = true; }
    }
    if (los && d < 12) fear = Math.max(fear, 0.3 * (1 - d / 12));
  }
  if (me.ch && !S.lastChased) sound.sting();
  S.lastChased = me.ch;
  if (grabbed) fear = 1;
  if (caught) fear = 0.2;
  S.fear = fear;

  S.creakIn -= dt;
  if (S.creakIn <= 0) { S.creakIn = 10 + Math.random() * 25; sound.creak(); }

  sound.setListener(camX, camY, camZ, camYaw);
  sound.updateBeds(dt, {
    fear, exhaustion: Math.max(S.exhausted, downed ? 0.6 : 0, me.hp < 35 ? 0.4 : 0), chasing: chasing || grabbed,
    inLocker: hidden, prefectNear: clamp(1 - nearest / 10, 0, 1),
  });

  // --- arms ---
  const held = me.carry !== null ? world.items.get(me.carry)?.userData.kind : me.th !== null ? world.items.get(me.th)?.userData.kind : healing ? 'syringe' : null;
  arms.setHeld(held || null);
  S.sway.x *= 1 - Math.min(1, dt * 8); S.sway.y *= 1 - Math.min(1, dt * 8);
  const mode = hidden || escaped ? 'hidden' : caught ? 'caught' : grabbed ? 'grab' : downed ? 'downed' : healing ? 'heal'
    : (me.hold === 'lever' || me.hold === 'revive') ? 'hold' : me.hold === 'plate' ? 'plate' : 'normal';
  arms.update(dt, { moving: S.moving, running: S.running, crouch: crouching, bob: S.bob, mode, held: !!held, sway: S.sway });

  // --- night vision & render ---
  const batteryDead = me.bat <= 0.001;
  let nvOn = S.nvOn && !batteryDead ? 1 : 0;
  if (nvOn && me.bat < 0.12 && Math.random() < 0.08) nvOn = 0;
  irLight.intensity = nvOn ? TUNE.irPower : 0;
  arms.light.intensity = nvOn ? 0.08 : 0.01;
  S.fade = Math.max(0, S.fade - dt * 0.7);
  if (me.hp < S.lastHp - 0.5) nv.hit = Math.max(nv.hit, 0.6);
  S.lastHp = me.hp;
  nv.render(scene, camera, world.lights, dt, {
    nvOn, battery: me.bat, fear, hide: hidden ? (me.hk || 'locker') : null, caught,
    hurt: downed ? 1 : clamp((45 - me.hp) / 45, 0, 1), downed, shake: S.shake,
    fade: escaped && !remotes.size ? 0.9 : S.fade,
  }, eyePass(), arms);
  updateHud();
}

// Debug handle for testing in the browser console: __programme.S, __programme.world
window.__programme = { S, world, net, voice, sound, nv, TUNE, arms };
