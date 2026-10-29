// Tuning knobs. Most of the "feel" lives here — tweak and replay.
export const TICK_HZ = 15;
export const MAX_PLAYERS = 4;

export const PLAYER = {
  radius: 0.35,
  walk: 3.0,
  run: 5.2,
  crouch: 1.5,
  staminaSeconds: 5,      // full sprint duration
  staminaRegen: 0.6,      // per second, as fraction of max... per second of rest
  eyeHeight: 1.6,
  crouchEyeHeight: 0.95,
  interactRange: 2.0,
};

export const NOISE = {
  walk: 5,          // radius in metres a footstep can be heard
  run: 13,
  crouch: 0,
  door: 10,
  bell: 40,         // the whole wing hears the bells
  bottle: 14,
  plateHum: 9,      // per second while the plate is held
  talk: 6,
  shout: 13,
  radio: 4,
  locker: 6,
  throughWalls: 0.55, // multiplier when there's no line of sight
};

export const PREFECT = {
  radius: 0.45,
  patrolSpeed: 1.9,
  investigateSpeed: 2.8,
  chaseSpeed: 4.4,          // faster than walking, slower than sprinting
  viewDistance: 16,
  viewHalfAngle: 55 * Math.PI / 180,
  crouchViewDistance: 6,    // a still, crouched player is hard to spot
  peripheralDistance: 3.5,  // will notice you right behind it
  catchDistance: 1.3,
  loseSightSeconds: 3.5,
  searchSeconds: 9,
  lockerCheckChance: 0.25,
};

export const NV = {
  drainPerSecond: 1 / 150,  // battery lasts 2.5 minutes of night vision
  batteryPickup: 0.6,
};

export const LESSON = {
  plateGraceSeconds: 1.2,   // gate stays open this long after leaving the plate
  plateGraceSolo: 8,
  leverHoldSeconds: 3,
  plateHoldMin: 0,
  lightsOutSeconds: 35,
};
