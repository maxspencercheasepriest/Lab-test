# The Programme

*A residential behavioural course. Pennines, 1974.*

A co-op horror game for 1–4 players in the spirit of *The Outlast Trials*. Runs on Mac, PC and Linux, with cross-play. You're volunteers on a reform course. Every night is a Lesson: finish the tasks, get out, and don't let the staff take you to Correction.

- **The staff patrol.** The Prefect and his Orderlies walk the wing room to room, lingering, looking about and checking lockers and beds. They don't know where you are. A glimpse makes them come and look; a proper look starts a chase. Noises send them to investigate. Lose them and they search the area, then go back to their rounds. An eye at the top of the screen shows when you're being noticed.
- **Two kinds of enemy.** **Orderlies** beat you down with a cosh. When you're downed, crawl to a friend so they can pick you up before you bleed out. **The Prefect** grabs you: mash **E/Space** to struggle free, or he drags you to Correction. A friend can free you by throwing something at him, or later by pulling the lever in Correction.
- **No weapons, just tricks.** Hide in lockers or under beds. Throw bottles and bricks to distract, or hit an enemy to stun it. Slam doors in their faces. Crouch past broken glass. Use syringes to heal.
- **Night vision is all you've got.** A small green tube in the middle of your view. Outside it, your eyes in the dark: almost black. Only real light gets through, like the Prefect's lantern or the exit sign. Your hands sit at the bottom of the tube.
- **Proximity voice chat.** Friends sound like they're where they are. Quiet talk is safe; shouting carries. Hold **R** for the radio.
- **It escalates.** The bells put the lanterns out. Returning the reels lets another Orderly loose. Taking the key draws the staff towards the exit.

## Lesson One: the tasks (always on screen, ticked off as you go)

1. Ring the four chapel bells. Everyone hears them, staff included.
2. Find the three film reels and return them to the projector. They're hidden somewhere different every Lesson.
3. One player stands on the pressure plate in the Old Classroom to raise the study gate. Another goes in for the key. The gate drops if the plate is released.
4. Unlock the exit in the Entrance Hall and go home.

If everyone is caught or down, the Lesson is failed.

## Controls

| Key | Action |
| --- | --- |
| WASD / mouse | Move / look |
| Shift | Run (loud, limited stamina) |
| C (toggle) or Ctrl (hold) | Crouch (silent, harder to spot) |
| E | Use. Hold for the plate, the lever and helping a friend up |
| E / Space (mash) | Struggle when grabbed |
| Q or left click | Throw bottle / brick |
| F | Use a syringe |
| G | Drop what you're carrying |
| N | Night vision on/off (saves battery) |
| R (hold) | Radio |
| M | Mute mic |
| Tab (hold) | Show controls |

Headphones are strongly recommended. Chrome or Edge are the most reliable browsers; Firefox and Safari should work.

## Desktop app (Windows .exe / Mac .dmg)

Download from the repo's **Releases** page (right-hand side on GitHub):

- **Windows:** `The-Programme-Setup-x.y.z.exe` (installer) or `The-Programme-Portable-x.y.z.exe` (runs without installing). The app isn't code-signed, so Windows SmartScreen will warn you. Click **More info → Run anyway**. Allow it through the firewall when asked, so friends can connect to you.
- **Mac:** `The-Programme-x.y.z-mac.dmg` (Intel and Apple Silicon). Drag it to Applications. The first time, macOS will block it because it isn't from an identified developer. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**. Allow the microphone when asked.

**Playing together in the app:**

1. The host clicks **Create a room**. The lobby shows their address and a 4-letter code.
2. Friends type the host's address into **Friend's address**, enter the code, and click **Join room**.
   - On the same network, use the address shown, e.g. `192.168.1.20:8080`.
   - Over the internet, the host forwards **TCP port 8080** on their router to their computer, and friends use the host's public IP, e.g. `203.0.113.5:8080`. If you've deployed the server to Render, friends can type that `https://…onrender.com` address instead and skip port forwarding.

Everyone needs the same version of the app.

**How the apps get built:** every push to `main` triggers GitHub Actions (the **Build desktop apps** workflow), which builds the `.exe` on a Windows machine and the `.dmg` on a Mac, then publishes them as a Release named after the `version` in `package.json`. Bump the version to make a new Release; otherwise the existing one is updated. You can also run it by hand from the **Actions** tab.

Locally, `npm run desktop` runs the app from source, and `npm run dist:win` / `npm run dist:mac` build installers. A `.dmg` can only be built on a Mac.

## Running it from source (browser version)

You need **Node.js 20 or newer**.

```bash
npm install
npm start
```

Then open http://localhost:8080. One person clicks **Create a room** and sends the 4-letter code (or the page link) to the others.

### Playing with friends over the internet

Browsers only allow microphone access on `https://` pages (or `localhost`), so friends need an HTTPS link. There are two easy options.

**Option A: tunnel from your own PC (quickest, free)**

```bash
npm start
# in a second terminal:
npx cloudflared tunnel --url http://localhost:8080
```

This prints a `https://something.trycloudflare.com` link. Send it to your friends. It works for as long as both commands are running.

**Option B: host it on Render (free tier)**

1. Sign in at https://render.com with GitHub.
2. Choose **New → Blueprint** and pick this repo. `render.yaml` sets everything up.
3. Wait for the deploy, then share the `https://….onrender.com` URL.

The free tier sleeps when idle, so the first load can take about 30 seconds.

**Option C: Fly.io (or any Docker host).** There's a `Dockerfile`. Run `fly launch` and accept the defaults; the app listens on `$PORT` (default 8080).

### Voice chat notes

Voice is peer-to-peer (WebRTC) using public STUN servers. This works on most home networks. If two players can hear the game but not each other, one of them is probably behind a strict NAT (some mobile hotspots and corporate networks). Fixing that needs a TURN server, which can be added in `public/js/voice.js`.

## Tuning and modding

- **`shared/map.js`**: the level as ASCII art, plus the list of rooms the staff patrol. The legend is at the top of the file. Edit it, restart, and the level rebuilds. Every row must be the same width.
- **`shared/constants.js`**: speeds, hearing, how quickly the staff notice you, damage, grab difficulty, battery life, and so on. Most of the game's feel lives here.
- **`shared/tannoy.js`**: everything the Presenter says.
- **`public/js/nightvision.js`**: the night-vision and periphery shader.
- In the browser console, `__programme.TUNE.irPower` changes night-vision brightness live.

Running the server with `DEV=1 npm start` turns off the anti-teleport check, which is handy for testing from the console. `npm test` runs headless checks of the simulation and networking.

## How it's built

- `server/`: Node + `ws`. The server is authoritative for the enemy AI (`server/enemy.js`: room-to-room patrol → curious → investigate → search → chase → attack/grab), health, tasks, catching and freeing, at 15 ticks a second.
- `public/`: Three.js, no build step. Procedural textures and fully synthesised audio, so there are no asset files. First-person arms are in `public/js/arms.js`.
- `shared/`: map, grid maths (collision, line of sight, A*) and tuning, used by both sides.
