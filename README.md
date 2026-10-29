# The Programme

*A residential behavioural course. Pennines, 1974.*

A co-op horror game for 1–4 players that runs in the browser (Mac, PC and Linux, with cross-play). You're volunteers on a reform course. Every night is a Lesson: finish the tasks, get out, and don't let the Prefect take you to Correction.

- **The Prefect hunts by sound.** Walking is quiet, running is loud, crouching is silent. Your voice carries. The bells carry everywhere.
- **Night vision is a small green tube.** Around it, your naked-eye periphery is dark and blurry, but it gets more sensitive towards the edges of the screen and catches movement.
- **Proximity voice chat.** Friends sound like they're where they are, muffled through walls. Hold **R** for the crackly radio, which everyone hears.
- **No weapons.** Hide in lockers, throw bottles to lead him away, and pull the lever in Correction to free caught friends.

## Lesson One: the tasks

1. Ring the four chapel bells. Everyone hears them, including the Prefect.
2. Return the three film reels to the projector.
3. One player stands on the pressure plate in the old classroom to raise the gate. Another goes into the study for the key. The gate closes behind them if the plate is released.
4. Unlock the exit (south wall, east wing) and go home.

If everyone is caught, the Lesson is failed.

## Controls

| Key | Action |
| --- | --- |
| WASD / mouse | Move / look |
| Shift | Run (loud, limited stamina) |
| C (toggle) or Ctrl (hold) | Crouch (silent) |
| E | Use. Hold for the plate and the lever |
| Q or left click | Throw bottle |
| G | Drop what you're carrying |
| N | Night vision on/off (saves battery) |
| R (hold) | Radio |
| M | Mute mic |
| Tab (hold) | Notebook / task list |

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

**Building the apps yourself:** go to the repo's **Actions** tab → **Build desktop apps** → **Run workflow**. To publish a new Release, push a version tag:

```bash
npm version patch   # bumps the version and creates a tag like v1.0.1
git push --follow-tags
```

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

- **`shared/map.js`**: the level as ASCII art. The legend is at the top of the file. Edit it, restart, and the level rebuilds. Every row must be the same width.
- **`shared/constants.js`**: speeds, hearing distances, vision, battery life, and so on. Most of the game's feel lives here.
- **`shared/tannoy.js`**: everything the Presenter says.
- **`public/js/nightvision.js`**: the night-vision and periphery shader.
- In the browser console, `__programme.TUNE.irPower` changes night-vision brightness live.

Running the server with `DEV=1 npm start` turns off the anti-teleport check, which is handy for testing from the console. `npm test` runs headless checks of the simulation and networking.

## How it's built

- `server/`: Node + `ws`. The server is authoritative for the Prefect AI (patrol → investigate → search → chase), tasks, catching and freeing, at 15 ticks a second.
- `public/`: Three.js, no build step. Procedural textures and fully synthesised audio, so there are no asset files.
- `shared/`: map, grid maths (collision, line of sight, A*) and tuning, used by both sides.
