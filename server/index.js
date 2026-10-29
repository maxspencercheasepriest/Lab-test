// The Programme — game server.
// Serves the browser client and runs one Lesson per room over WebSockets.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_PLAYERS } from '../shared/constants.js';
import { Lesson } from './game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json',
};
const ROUTES = [
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/build')],
  ['/', path.join(ROOT, 'public')],
];

export function startServer({ port = +process.env.PORT || 8080, host = '0.0.0.0' } = {}) {
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  for (const [prefix, dir] of ROUTES) {
    if (!url.startsWith(prefix)) continue;
    const file = path.join(dir, url.slice(prefix.length));
    if (!file.startsWith(dir)) break;
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }
  res.writeHead(404); res.end('Not found');
});

// ---- rooms -------------------------------------------------------------

const rooms = new Map();
let nextId = 1;

const makeCode = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
};

function createRoom() {
  const room = {
    code: makeCode(),
    players: new Map(),   // id -> { id, name, ws }
    host: null,
    lesson: null,
    send(id, msg) {
      const p = this.players.get(id);
      if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
    },
    broadcast(msg) {
      const s = JSON.stringify(msg);
      for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
    },
    lobby() {
      this.broadcast({ t: 'lobby', code: this.code, host: this.host, inLesson: !!this.lesson,
        players: [...this.players.values()].map(p => ({ id: p.id, name: p.name })) });
    },
    endLesson() {
      if (this.lesson) this.lesson.stop();
      this.lesson = null;
      this.lobby();
    },
  };
  rooms.set(room.code, room);
  return room;
}

const wss = new WebSocketServer({ server });
wss.on('error', () => {}); // listen errors are reported by startServer()

wss.on('connection', (ws) => {
  const id = nextId++;
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (room) return;
      const name = String(m.name || 'Pupil').replace(/[^\w \-']/g, '').slice(0, 16).trim() || 'Pupil';
      const code = String(m.code || '').toUpperCase().trim();
      if (code) {
        room = rooms.get(code);
        if (!room) return ws.send(JSON.stringify({ t: 'error', text: `No room called ${code}.` }));
        if (room.lesson) { room = null; return ws.send(JSON.stringify({ t: 'error', text: 'That Lesson has already started.' })); }
        if (room.players.size >= MAX_PLAYERS) { room = null; return ws.send(JSON.stringify({ t: 'error', text: 'That room is full.' })); }
      } else room = createRoom();
      room.players.set(id, { id, name, ws });
      if (!room.host) room.host = id;
      ws.send(JSON.stringify({ t: 'welcome', id, code: room.code }));
      // Tell existing players to set up voice with the newcomer.
      room.broadcast({ t: 'peer', id, name });
      room.lobby();
      return;
    }
    if (!room) return;

    switch (m.t) {
      case 'start':
        if (id === room.host && !room.lesson) room.lesson = new Lesson(room);
        break;
      case 'state': room.lesson?.onState(id, m); break;
      case 'noise': room.lesson?.onNoise(id, m); break;
      case 'act': room.lesson?.onAct(id, m); break;
      case 'hold': room.lesson?.onHold(id, m); break;
      case 'throw': room.lesson?.onThrow(id, m); break;
      case 'leave': room.lesson?.onAct(id, { a: 'drop' }); break;
      case 'rtc': // WebRTC voice signalling relay
        if (room.players.has(m.to)) room.send(m.to, { t: 'rtc', from: id, data: m.data });
        break;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.players.delete(id);
    room.lesson?.removePlayer(id);
    room.broadcast({ t: 'peerLeft', id });
    if (!room.players.size) {
      room.lesson?.stop();
      rooms.delete(room.code);
      return;
    }
    if (room.host === id) room.host = room.players.keys().next().value;
    room.lobby();
  });
});

// Drop dead connections.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

return new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    const actual = server.address().port;
    console.log(`The Programme is running on http://localhost:${actual}`);
    resolve({ server, port: actual });
  });
});
}

// Run directly with `node server/index.js` / `npm start`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((e) => { console.error(e.message); process.exit(1); });
}
