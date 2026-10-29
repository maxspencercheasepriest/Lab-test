// Grid maths shared by server and client: collision, line of sight, pathfinding.
import { TILE, W, H, MAP, SOLID_STATIC, OPAQUE_STATIC } from './map.js';

export const tkey = (x, z) => z * W + x;

// `dyn` describes the moving parts of the level:
//   dyn.doors: Map<tkey, boolean open>, dyn.gateOpen, dyn.exitOpen
export function isSolidTile(x, z, dyn, opts = {}) {
  if (x < 0 || z < 0 || x >= W || z >= H) return true;
  const c = MAP[z][x];
  if (SOLID_STATIC.has(c)) return true;
  if (c === 'D') return opts.doorsPassable ? false : !dyn.doors.get(tkey(x, z));
  if (c === 'G') return !dyn.gateOpen;
  if (c === 'E') return !dyn.exitOpen;
  return false;
}

export function isOpaqueTile(x, z, dyn) {
  if (x < 0 || z < 0 || x >= W || z >= H) return true;
  const c = MAP[z][x];
  if (OPAQUE_STATIC.has(c)) return true;
  if (c === 'D') return !dyn.doors.get(tkey(x, z));
  if (c === 'E') return !dyn.exitOpen;
  return false;
}

// Line of sight between two world points (2D, ignores height).
export function lineOfSight(ax, az, bx, bz, dyn) {
  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  const steps = Math.ceil(dist / (TILE * 0.2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = Math.floor((ax + dx * t) / TILE);
    const z = Math.floor((az + dz * t) / TILE);
    if (isOpaqueTile(x, z, dyn)) return false;
  }
  return true;
}

// Push a circle (radius r) out of solid tiles. Returns corrected {x,z}.
export function collideCircle(px, pz, r, dyn, opts) {
  let x = px, z = pz;
  for (let iter = 0; iter < 2; iter++) {
    const tx0 = Math.floor((x - r) / TILE), tx1 = Math.floor((x + r) / TILE);
    const tz0 = Math.floor((z - r) / TILE), tz1 = Math.floor((z + r) / TILE);
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!isSolidTile(tx, tz, dyn, opts)) continue;
        const minX = tx * TILE, maxX = minX + TILE, minZ = tz * TILE, maxZ = minZ + TILE;
        const cx = Math.max(minX, Math.min(x, maxX));
        const cz = Math.max(minZ, Math.min(z, maxZ));
        let ddx = x - cx, ddz = z - cz;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          x = cx + (ddx / d) * r;
          z = cz + (ddz / d) * r;
        } else {
          // Centre inside the tile: push out along the shortest axis.
          const pl = x - minX, pr = maxX - x, pu = z - minZ, pd = maxZ - z;
          const m = Math.min(pl, pr, pu, pd);
          if (m === pl) x = minX - r; else if (m === pr) x = maxX + r;
          else if (m === pu) z = minZ - r; else z = maxZ + r;
        }
      }
    }
  }
  return { x, z };
}

// A* over tiles. Doors count as passable (the Prefect opens them).
export function findPath(from, to, dyn) {
  const opts = { doorsPassable: true };
  if (isSolidTile(to.x, to.z, dyn, opts)) return null;
  const start = tkey(from.x, from.z), goal = tkey(to.x, to.z);
  const g = new Map([[start, 0]]);
  const came = new Map();
  const open = [{ k: start, x: from.x, z: from.z, f: 0 }];
  const closed = new Set();
  const h = (x, z) => Math.hypot(x - to.x, z - to.z);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let guard = 0;
  while (open.length && guard++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.k === goal) {
      const path = [];
      let k = goal;
      while (k !== undefined) { path.push({ x: k % W, z: Math.floor(k / W) }); k = came.get(k); }
      return path.reverse();
    }
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);
    for (const [dx, dz] of dirs) {
      const nx = cur.x + dx, nz = cur.z + dz;
      if (isSolidTile(nx, nz, dyn, opts)) continue;
      if (dx && dz) {
        // No corner cutting, and never diagonal through a doorway.
        if (isSolidTile(cur.x + dx, cur.z, dyn, opts) || isSolidTile(cur.x, cur.z + dz, dyn, opts)) continue;
        if (MAP[nz][nx] === 'D' || MAP[cur.z][cur.x] === 'D') continue;
      }
      const nk = tkey(nx, nz);
      const ng = g.get(cur.k) + (dx && dz ? 1.414 : 1);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        came.set(nk, cur.k);
        open.push({ k: nk, x: nx, z: nz, f: ng + h(nx, nz) });
      }
    }
  }
  return null;
}

// All walkable tiles (used for patrol points and map validation).
export function walkableTiles(dyn) {
  const out = [];
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    if (!isSolidTile(x, z, dyn, { doorsPassable: true }) && MAP[z][x] !== 'G' && MAP[z][x] !== 'E') out.push({ x, z });
  }
  return out;
}
