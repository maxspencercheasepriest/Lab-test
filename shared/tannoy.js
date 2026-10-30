// The Presenter. Cheerful, encouraging, completely without mercy.
// {name} is replaced with a player's name.
export const TANNOY = {
  start: [
    "Good evening, children! Welcome to Lesson One. Tonight's lesson is about listening. The Prefect and his Orderlies will be listening too.",
  ],
  tasks: [
    "Your homework tonight: ring the four chapel bells for the Headmaster, return the three missing reels to the projector, and fetch the key from the study. Then you may go home.",
  ],
  grace: [
    "Lights out, children. Off you go. The staff are doing their rounds.",
  ],
  bell: [
    "Lovely ringing! The Headmaster heard that. So did everybody else.",
    "Ding dong! Gosh, that carries, doesn't it? Run along now.",
    "Another bell! Somebody is being very brave. Or very silly.",
  ],
  bellsDone: [
    "All four bells! Splendid. And now, a little surprise. Lanterns out, everybody!",
  ],
  lightsOn: [
    "Lanterns back on. Did you miss them? They didn't.",
  ],
  reel: [
    "A reel returned! Films are a privilege, not a right.",
    "Thank you, {name}. The projector is very hungry tonight.",
  ],
  reelsDone: [
    "All reels returned. We'll watch them together, later. You'll all be in them. Oh — and I've let another Orderly out. He was lonely.",
  ],
  plate: [
    "Somebody's standing on the plate. Doesn't that tingle? It hums, you know. They can hear it hum.",
  ],
  key: [
    "{name} has the study key! Naughty. Very naughty. The Prefect will be waiting by the doors.",
  ],
  grab: [
    "Struggle, {name}! Struggling builds character!",
    "Oh, he's got you, {name}. Wriggle!",
  ],
  escapeGrab: [
    "{name} wriggled free! How rude.",
  ],
  caught: [
    "Oh dear. {name} has been caught. Correction for {name}.",
    "{name}! Running in the corridors! Off to Correction.",
    "Hard luck, {name}. Correction is good for you.",
  ],
  downed: [
    "{name} has had a little fall. Will anybody help? No? Character building.",
    "Man down! Well, child down. {name} is bleeding on my clean floor.",
  ],
  revived: [
    "{name} is back on their feet. Teamwork! How disappointing.",
  ],
  bledOut: [
    "{name} took too long getting up. Off to Correction with you.",
  ],
  freed: [
    "Who let them out? Somebody pulled the lever. I'll be having words.",
  ],
  stunned: [
    "Throwing things at staff! That's a detention.",
    "Slamming doors on staff! Manners, please!",
  ],
  chase: [
    "Run, run, little one!",
    "Faster, {name}! He's ever so close.",
    "Ooh, somebody's been spotted!",
  ],
  idle: [
    "It's very quiet. Are you hiding? Hiding is cheating, you know.",
    "Reminder: lights out is not an excuse to stop learning.",
    "The Prefect has asked me to tell you he's getting hungry.",
    "Has anybody seen my reading glasses? No? Never mind.",
    "Mind the glass in the washroom, children. And the boiler room. And the infirmary.",
    "The Orderlies are paid by the bruise.",
  ],
  exitOpen: [
    "The door is unlocked. Well done, children. Go on. Go home. Everybody's coming to say goodbye.",
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
