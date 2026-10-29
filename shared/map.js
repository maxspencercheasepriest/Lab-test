// Lesson One: the East Wing.
// Edit this map freely — every row must be the same width.
//
//  #  wall              .  floor             D  door (opens/closes)
//  S  player spawn      X  Prefect spawn     L  locker (hide inside)
//  B  chapel bell       R  film reel         P  projector (deliver reels)
//  H  pressure plate    G  gate (open while someone stands on the plate)
//  K  study key         E  exit door         C  correction cage
//  l  cage lever        b  bottle (throw)    v  spare battery
//
// One tile = TILE metres.

export const TILE = 2.5;
export const WALL_H = 3.2;

export const MAP = [
  '########################################',
  '#......#..........#.........#..........#',
  '#.SSS..#.L.L.L.L..#..b......#..B....B..#',
  '#.SSS..#..........#.........#..........#',
  '#......D..........D....R....#..........#',
  '#..v...#.L.L.L.L..#.........#....##....#',
  '#......#..........#.........#..........#',
  '###D########D###########D#######D#######',
  '#......................................#',
  '#...b...........X..............b.......#',
  '#......................................#',
  '######D#######D#########D########D######',
  '#.........#.........#.........#........#',
  '#...R.....#..L...L..#....P....#..B.....#',
  '#.........#.........#.........#........#',
  '#....b....D.........D.........#........#',
  '#.........#..L...L..#..R......#...B..v.#',
  '#.........#.........#.........#........#',
  '#####D#####.........###########........#',
  '#.........###########.........####D#####',
  '#..C..C...#.........#.........#........#',
  '#.........#..H......G....K....#........#',
  '#..l......D.........#.........#........#',
  '#.........#..L......#.....L...#........#',
  '##################################EE####',
];

export const W = MAP[0].length;
export const H = MAP.length;

// Tiles nobody can walk through (doors/gates/exit are handled dynamically).
export const SOLID_STATIC = new Set(['#', 'L', 'B', 'P', 'l', 'C']);
// Tiles that block sight when there.
export const OPAQUE_STATIC = new Set(['#', 'L']);

export function parseMap() {
  const out = {
    spawns: [], prefect: null, lockers: [], bells: [], reels: [], projector: null,
    plate: null, gates: [], key: null, exits: [], cages: [], lever: null,
    bottles: [], batteries: [], doors: [],
  };
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const c = MAP[z][x];
      const t = { x, z };
      switch (c) {
        case 'S': out.spawns.push(t); break;
        case 'X': out.prefect = t; break;
        case 'L': out.lockers.push(t); break;
        case 'B': out.bells.push(t); break;
        case 'R': out.reels.push(t); break;
        case 'P': out.projector = t; break;
        case 'H': out.plate = t; break;
        case 'G': out.gates.push(t); break;
        case 'K': out.key = t; break;
        case 'E': out.exits.push(t); break;
        case 'C': out.cages.push(t); break;
        case 'l': out.lever = t; break;
        case 'b': out.bottles.push(t); break;
        case 'v': out.batteries.push(t); break;
        case 'D': out.doors.push(t); break;
      }
    }
  }
  return out;
}

export function tileAt(x, z) {
  if (x < 0 || z < 0 || x >= W || z >= H) return '#';
  return MAP[z][x];
}

export const tileCenter = (t) => ({ x: (t.x + 0.5) * TILE, z: (t.z + 0.5) * TILE });
export const toTile = (wx, wz) => ({ x: Math.floor(wx / TILE), z: Math.floor(wz / TILE) });
