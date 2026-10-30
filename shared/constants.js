// Tuning knobs. Most of the "feel" lives here — tweak and replay.
export const TICK_HZ = 15;
export const MAX_PLAYERS = 4;

export const PLAYER = {
  radius: 0.35,
  walk: 3.0,
  run: 5.4,
  crouch: 1.5,
  crawl: 0.6,             // when downed
  limp: 0.8,              // speed multiplier below 35 health
  staminaSeconds: 5,
  eyeHeight: 1.6,
  crouchEyeHeight: 0.95,
  downedEyeHeight: 0.35,
  interactRange: 2.0,
  maxHealth: 100,
  regenTo: 30,            // slowly heal back up to this on your own
  regenDelay: 8,
  regenPerSecond: 1.5,
  syringeHeal: 55,
  syringeSeconds: 1.4,
  maxSyringes: 2,
  bleedOutSeconds: 45,
  reviveSeconds: 3,
  reviveHealth: 35,
};

export const NOISE = {
  walk: 4,          // radius in metres a footstep can be heard
  run: 12,
  crouch: 0,
  glass: 11,        // stepping on broken glass without crouching
  door: 8,
  slam: 14,
  bell: 60,         // the whole wing hears the bells (30+ ignores walls)
  bottle: 14,
  plateHum: 8,
  talk: 3,          // quiet talking only carries a few metres...
  shout: 10,        // ...shouting carries further
  radio: 3,
  locker: 6,
  struggle: 12,
  throughWalls: 0.5, // multiplier when there's no line of sight
};

// Enemy archetypes.
export const ENEMIES = {
  prefect: {
    radius: 0.45,
    patrolSpeed: 1.9,
    investigateSpeed: 2.7,
    chaseSpeed: 4.6,          // faster than walking, slower than sprinting
    viewDistance: 15,
    viewHalfAngle: 55 * Math.PI / 180,
    hearing: 1.0,
    noticeRate: 1.1,          // how fast suspicion builds when it can see you
    loseSightSeconds: 4,
    searchSeconds: 12,
    lingerSeconds: [4, 9],    // how long it lingers in each room on patrol
    hideCheckChance: 0.35,
    attack: 'grab',
    doorPause: 0.5,
    stunSeconds: 2.5,
  },
  orderly: {
    radius: 0.4,
    patrolSpeed: 1.8,
    investigateSpeed: 2.5,
    chaseSpeed: 4.2,
    viewDistance: 12,
    viewHalfAngle: 50 * Math.PI / 180,
    hearing: 0.8,
    noticeRate: 0.8,
    loseSightSeconds: 2.5,
    searchSeconds: 8,
    lingerSeconds: [3, 7],
    hideCheckChance: 0.2,
    attack: 'hit',
    hitDamage: 34,
    hitWindup: 0.45,
    hitCooldown: 1.6,
    hitRange: 1.7,
    doorPause: 0.9,
    stunSeconds: 3.5,
  },
};

export const DETECT = {
  instantDistance: 2.2,     // right in front of it: no hiding
  investigateAt: 0.35,      // suspicion level that makes it come and look
  decay: 0.3,               // per second when it can't see you
  graceSeconds: 15,         // at the start nobody hunts — get your bearings
};

export const GRAB = {
  seconds: 2.8,             // time to struggle free
  perPress: 0.13,           // progress per E/Space press (gets harder each grab)
  harderPerGrab: 0.2,
  escapeDamage: 15,
};

export const NV = {
  drainPerSecond: 1 / 160,  // battery lasts about 2.5 minutes of night vision
  batteryPickup: 0.6,
};

export const LESSON = {
  plateGraceSeconds: 1.2,   // gate stays open this long after leaving the plate
  plateGraceSolo: 8,
  leverHoldSeconds: 3,
  lightsOutSeconds: 40,
};
