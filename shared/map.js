// Lesson One: the East Wing.
// Edit this map freely — every row must be the same width.
//
//  #  wall              .  floor             D  door (opens/closes, slam on enemies)
//  S  player spawn      X  Prefect spawn     O  Orderly spawn
//  L  locker (hide)     U  bed (hide under)  T  desk / pew (low cover)
//  B  chapel bell       P  projector         H  pressure plate
//  G  gate (open while someone stands on the plate)
//  K  study key         E  exit door         C  correction cage
//  l  cage lever        g  broken glass (loud unless crouched)
//  *  item spot — film reels, bottles, bricks, batteries and syringes are
//     shuffled across these every Lesson.
//
// One tile = TILE metres.

export const TILE = 2.5;
export const WALL_H = 3.2;

export const MAP = [
  '############################################',
  '#U.U.U.U.U.LL#........#....................#',
  '#............#.gg.....#..B..............B..#',
  '#..SSS..*....#.gg..*..#....................#',
  '#............D........D..TTTT..TTTT..TTTT..#',
  '#..SSS....*..#....gg..#....................#',
  '#............#L.L.L.L.#..B....*.......*.B..#',
  '#U.U.U.U.U.LL#........#...........L........#',
  '######D###########D#########D########D######',
  '#.........LL...............*.....LL........#',
  '#....................X.........g.......O...#',
  '#.............gg...........*...............#',
  '######D##########D###################D######',
  '#LL.....*.LL#..........#L.....L#U.U.U.U.U..#',
  '#...........#.T.T.T.T..#.......#...........#',
  '#..TT...TT..#..........#..T.T..#....O......#',
  '#....P......D.T.T.T....G...K...#..g......*.#',
  '#..TT...TT..#..........#.......#...........#',
  '#...........#..H...L...#..*....#U.U.U.U.U..#',
  '#*........LL#..........#L.....L#*.........L#',
  '#####D###########D##########################',
  '#..........#...................#L........L.#',
  '#.C..C.....#.................*.#...........#',
  '#..........#....###########....#...T...T...#',
  '#..........D....###########....D...........#',
  '#........l.#....###########....#....*......#',
  '#*.........#.g.................#...........#',
  '#..........#...*..........gg...#L.........L#',
  '####################################EE######',
];

export const W = MAP[0].length;
export const H = MAP.length;

// Named rooms (inclusive tile rectangles) — the enemies patrol room to room.
export const ROOMS = [
  { name: 'Dormitory', x0: 1, z0: 1, x1: 12, z1: 7 },
  { name: 'Washroom', x0: 14, z0: 1, x1: 21, z1: 7 },
  { name: 'Chapel', x0: 23, z0: 1, x1: 42, z1: 7 },
  { name: 'Corridor West', x0: 1, z0: 9, x1: 21, z1: 11 },
  { name: 'Corridor East', x0: 22, z0: 9, x1: 42, z1: 11 },
  { name: 'Projection Room', x0: 1, z0: 13, x1: 11, z1: 19 },
  { name: 'Old Classroom', x0: 13, z0: 13, x1: 22, z1: 19 },
  { name: 'Study', x0: 24, z0: 13, x1: 30, z1: 19 },
  { name: 'Infirmary', x0: 32, z0: 13, x1: 42, z1: 19 },
  { name: 'Correction', x0: 1, z0: 21, x1: 10, z1: 27 },
  { name: 'Boiler Room', x0: 12, z0: 21, x1: 30, z1: 27 },
  { name: 'Entrance Hall', x0: 32, z0: 21, x1: 42, z1: 27 },
];

// Tiles nobody can walk through (doors/gates/exit are handled dynamically).
export const SOLID_STATIC = new Set(['#', 'L', 'B', 'P', 'l', 'C', 'U', 'T']);
// Tiles that block sight.
export const OPAQUE_STATIC = new Set(['#', 'L']);

export function parseMap() {
  const out = {
    spawns: [], prefect: null, orderlies: [], lockers: [], beds: [], bells: [], projector: null,
    plate: null, gates: [], key: null, exits: [], cages: [], lever: null, glass: [],
    spots: [], doors: [], desks: [],
  };
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const c = MAP[z][x];
      const t = { x, z };
      switch (c) {
        case 'S': out.spawns.push(t); break;
        case 'X': out.prefect = t; break;
        case 'O': out.orderlies.push(t); break;
        case 'L': out.lockers.push(t); break;
        case 'U': out.beds.push(t); break;
        case 'T': out.desks.push(t); break;
        case 'B': out.bells.push(t); break;
        case 'P': out.projector = t; break;
        case 'H': out.plate = t; break;
        case 'G': out.gates.push(t); break;
        case 'K': out.key = t; break;
        case 'E': out.exits.push(t); break;
        case 'C': out.cages.push(t); break;
        case 'l': out.lever = t; break;
        case 'g': out.glass.push(t); break;
        case '*': out.spots.push(t); break;
        case 'D': out.doors.push(t); break;
      }
    }
  }
  // Every hiding place: lockers and beds.
  out.hides = [...out.lockers.map(t => ({ ...t, kind: 'locker' })), ...out.beds.map(t => ({ ...t, kind: 'bed' }))];
  return out;
}

export function tileAt(x, z) {
  if (x < 0 || z < 0 || x >= W || z >= H) return '#';
  return MAP[z][x];
}

export function roomAt(x, z) {
  return ROOMS.find(r => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) || null;
}

export const tileCenter = (t) => ({ x: (t.x + 0.5) * TILE, z: (t.z + 0.5) * TILE });
export const toTile = (wx, wz) => ({ x: Math.floor(wx / TILE), z: Math.floor(wz / TILE) });
