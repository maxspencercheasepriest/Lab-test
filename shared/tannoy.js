// The Presenter. Cheerful, encouraging, completely without mercy.
// {name} is replaced with a player's name.
export const TANNOY = {
  start: [
    "Good evening, children! Welcome to Lesson One. Tonight's lesson is about listening. The Prefect will be listening too.",
  ],
  tasks: [
    "Your tasks tonight: ring the four chapel bells for the Headmaster, return the three missing reels to the projector, and fetch the key from the study. Then you may go home.",
  ],
  bell: [
    "Lovely ringing! The Headmaster heard that. So did the Prefect.",
    "Ding dong! Gosh, that carries, doesn't it?",
    "Another bell! Somebody is being very brave. Or very silly.",
  ],
  bellsDone: [
    "All four bells! Splendid. And now, a little surprise. Lights out, everybody!",
  ],
  lightsOn: [
    "Lights back on. Did you miss them? He didn't.",
  ],
  reel: [
    "A reel returned! Films are a privilege, not a right.",
    "Thank you, {name}. The projector is very hungry tonight.",
  ],
  reelsDone: [
    "All reels returned. We'll watch them together, later. You'll all be in them.",
  ],
  plate: [
    "Somebody's standing on the plate. Doesn't that tingle? It hums, you know. He can hear it hum.",
  ],
  key: [
    "{name} has the study key! Naughty. Very naughty. Keep going.",
  ],
  caught: [
    "Oh dear. {name} has been caught. Correction for {name}.",
    "{name}! Running in the corridors! Off to Correction.",
    "Hard luck, {name}. Correction is good for you.",
  ],
  freed: [
    "Who let them out? Somebody pulled the lever. I'll be having words.",
  ],
  chase: [
    "Run, run, little one!",
    "Faster, {name}! He's ever so close.",
    "Ooh, the Prefect has spotted somebody!",
  ],
  idle: [
    "It's very quiet. Are you hiding? Hiding is cheating, you know.",
    "Reminder: lights out is not an excuse to stop learning.",
    "The Prefect has asked me to tell you he's getting hungry.",
    "Has anybody seen my reading glasses? No? Never mind.",
  ],
  exitOpen: [
    "The door is unlocked. Well done, children. Go on. Go home. Your parents are waiting.",
  ],
  escaped: [
    "{name} has gone home. Lovely. We'll see you tomorrow.",
  ],
  fail: [
    "Everybody caught! Oh well. We'll start again tomorrow. And the day after. And the day after that.",
  ],
  win: [
    "Lesson complete. Release denied. See you tomorrow, children.",
  ],
};

export function pickLine(category, name = '') {
  const list = TANNOY[category] || [];
  const line = list[Math.floor(Math.random() * list.length)] || '';
  return line.replaceAll('{name}', name);
}
