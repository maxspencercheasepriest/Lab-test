// Builds the level from the shared ASCII map and keeps the moving parts in sync.
import * as THREE from 'three';
import { MAP, W, H, TILE, WALL_H, parseMap, tileCenter } from '/shared/map.js';
import { tkey } from '/shared/grid.js';

const MASK_LAYER = 1;

function lambert(opts) { return new THREE.MeshLambertMaterial(opts); }
function occluder(mesh) { mesh.layers.enable(MASK_LAYER); return mesh; }

// A white silhouette only drawn into the motion mask; brightness = how fast it moves.
function motionGhost(geo) {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  m.layers.set(MASK_LAYER);
  return m;
}

export class World {
  constructor(scene, tex) {
    this.scene = scene;
    this.tex = tex;
    this.map = parseMap();
    this.lights = [];
    this.doors = new Map();     // tkey -> { pivot, open, angle }
    this.items = new Map();     // id -> mesh
    this.players = new Map();   // id -> avatar
    this.dyn = { doors: new Map(), gateOpen: false, exitOpen: false };
    for (const d of this.map.doors) this.dyn.doors.set(tkey(d.x, d.z), false);
    this.build();
  }

  addLight(l) { this.lights.push(l); this.scene.add(l); return l; }

  build() {
    const s = this.scene;
    const T = this.tex;
    T.floor.repeat.set(W, H); T.ceiling.repeat.set(W, H);

    this.ambient = this.addLight(new THREE.AmbientLight(0xffffff, 0.035));

    // Floor and ceiling.
    const floor = occluder(new THREE.Mesh(new THREE.PlaneGeometry(W * TILE, H * TILE), lambert({ map: T.floor })));
    floor.rotation.x = -Math.PI / 2; floor.position.set(W * TILE / 2, 0, H * TILE / 2);
    s.add(floor);
    const ceil = occluder(new THREE.Mesh(new THREE.PlaneGeometry(W * TILE, H * TILE), lambert({ map: T.ceiling })));
    ceil.rotation.x = Math.PI / 2; ceil.position.set(W * TILE / 2, WALL_H, H * TILE / 2);
    s.add(ceil);

    // Walls (only the ones next to open space).
    const open = (x, z) => x >= 0 && z >= 0 && x < W && z < H && MAP[z][x] !== '#';
    const wallTiles = [];
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      if (MAP[z][x] !== '#') continue;
      if (open(x + 1, z) || open(x - 1, z) || open(x, z + 1) || open(x, z - 1) || open(x + 1, z + 1) || open(x - 1, z - 1) || open(x + 1, z - 1) || open(x - 1, z + 1)) wallTiles.push({ x, z });
    }
    const wallGeo = new THREE.BoxGeometry(TILE, WALL_H, TILE);
    const walls = occluder(new THREE.InstancedMesh(wallGeo, lambert({ map: T.wall }), wallTiles.length));
    const m4 = new THREE.Matrix4();
    wallTiles.forEach((t, i) => { const c = tileCenter(t); walls.setMatrixAt(i, m4.makeTranslation(c.x, WALL_H / 2, c.z)); });
    s.add(walls);

    // Doors, with a lintel above.
    const doorH = 2.4;
    const doorGeo = new THREE.BoxGeometry(TILE, doorH, 0.12);
    doorGeo.translate(TILE / 2, doorH / 2, 0); // hinge at the left edge
    const doorMat = lambert({ map: T.door });
    const lintelGeo = new THREE.BoxGeometry(TILE, WALL_H - doorH, TILE);
    const lintelMat = lambert({ map: T.wall });
    for (const d of this.map.doors) {
      const c = tileCenter(d);
      const alongX = MAP[d.z][d.x - 1] === '#' && MAP[d.z][d.x + 1] === '#';
      const pivot = new THREE.Group();
      pivot.position.set(c.x - (alongX ? TILE / 2 : 0), 0, c.z - (alongX ? 0 : TILE / 2));
      pivot.rotation.y = alongX ? 0 : -Math.PI / 2;
      const panel = occluder(new THREE.Mesh(doorGeo, doorMat));
      panel.add(motionGhost(doorGeo));
      pivot.add(panel);
      s.add(pivot);
      const lintel = occluder(new THREE.Mesh(lintelGeo, lintelMat));
      lintel.position.set(c.x, doorH + (WALL_H - doorH) / 2, c.z);
      s.add(lintel);
      this.doors.set(tkey(d.x, d.z), { pivot, base: pivot.rotation.y, open: 0, target: 0, ghost: panel.children[0] });
    }

    // Lockers: a bank of lockers filling the tile.
    const lockerGeo = new THREE.BoxGeometry(TILE * 0.96, 2.5, TILE * 0.96);
    const lt = T.locker.clone(); lt.repeat.set(3, 1); lt.needsUpdate = true;
    const lockerMat = lambert({ map: lt });
    for (const l of this.map.lockers) {
      const c = tileCenter(l);
      const m = occluder(new THREE.Mesh(lockerGeo, lockerMat));
      m.position.set(c.x, 1.25, c.z);
      s.add(m);
    }

    // Chapel bells on wooden frames.
    const wood = lambert({ color: 0x3a2a1c });
    const brass = lambert({ color: 0x8a7030, emissive: 0x110c00 });
    const bellPts = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; bellPts.push(new THREE.Vector2(0.12 + 0.5 * Math.pow(t, 1.8), 0.9 - t * 0.9)); }
    const bellGeo = new THREE.LatheGeometry(bellPts, 16);
    this.bellMeshes = [];
    for (const b of this.map.bells) {
      const c = tileCenter(b);
      const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
      for (const sx of [-1, 1]) { const post = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.8, 0.2), wood)); post.position.set(sx * 1.0, 1.4, 0); g.add(post); }
      const beam = occluder(new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.22, 0.25), wood)); beam.position.y = 2.8; g.add(beam);
      const swing = new THREE.Group(); swing.position.y = 2.7;
      const bell = occluder(new THREE.Mesh(bellGeo, brass)); bell.position.y = -1.0; swing.add(bell);
      bell.add(motionGhost(bellGeo));
      g.add(swing);
      s.add(g);
      this.bellMeshes.push({ swing, t: 99, rung: false });
    }

    // Projector on a table.
    {
      const c = tileCenter(this.map.projector);
      const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
      const table = occluder(new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 1.6), wood)); table.position.y = 0.45; g.add(table);
      const body = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 0.9), lambert({ color: 0x222222 }))); body.position.y = 1.15; g.add(body);
      this.reelSlots = [];
      for (const dz of [-0.3, 0.3]) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 18), lambert({ color: 0x333333 }));
        r.rotation.x = Math.PI / 2; r.rotation.z = Math.PI / 2; r.position.set(0, 1.6, dz); r.visible = false; g.add(r); this.reelSlots.push(r);
      }
      s.add(g);
      this.projectorLight = this.addLight(new THREE.SpotLight(0xfff2d0, 0, 18, 0.35, 0.6, 1));
      this.projectorLight.position.set(c.x, 1.2, c.z);
      this.projectorLight.target.position.set(c.x - 10, 1.4, c.z);
      s.add(this.projectorLight.target);
      this.projectorOn = 0;
    }

    // Pressure plate.
    {
      const c = tileCenter(this.map.plate);
      this.plate = occluder(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 1.6), lambert({ color: 0x555a5c, emissive: 0x000000 })));
      this.plate.position.set(c.x, 0.03, c.z);
      s.add(this.plate);
    }

    // Gate: iron bars that slide up into the ceiling.
    this.gates = [];
    for (const gt of this.map.gates) {
      const c = tileCenter(gt);
      const alongX = MAP[gt.z][gt.x - 1] === '#' && MAP[gt.z][gt.x + 1] === '#';
      const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
      const barGeo = new THREE.CylinderGeometry(0.04, 0.04, WALL_H, 6);
      const iron = lambert({ color: 0x2a2a2a });
      for (let i = 0; i < 9; i++) {
        const o = -TILE / 2 + (i + 0.5) * (TILE / 9);
        const bar = occluder(new THREE.Mesh(barGeo, iron));
        bar.position.set(alongX ? o : 0, WALL_H / 2, alongX ? 0 : o);
        bar.add(motionGhost(barGeo));
        g.add(bar);
      }
      s.add(g);
      this.gates.push({ g, y: 0 });
    }

    // Exit doors in the outer wall, with a sign over them.
    {
      const cs = this.map.exits.map(tileCenter);
      const cx = cs.reduce((a, c) => a + c.x, 0) / cs.length;
      const cz = cs[0].z - TILE / 2 - 0.02;
      const doorMatE = lambert({ color: 0x3b2c1e, map: this.tex.door });
      this.exitDoors = [];
      for (const side of [-1, 1]) {
        const geo = new THREE.BoxGeometry(TILE, 2.8, 0.15);
        geo.translate(-side * TILE / 2, 1.4, 0);
        const pivot = new THREE.Group(); pivot.position.set(cx + side * TILE, 0, cz);
        const m = occluder(new THREE.Mesh(geo, doorMatE)); pivot.add(m);
        s.add(pivot); this.exitDoors.push({ pivot, side });
      }
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.35), new THREE.MeshBasicMaterial({ map: this.tex.sign }));
      sign.position.set(cx, 3.0, cz - 0.03); sign.rotation.y = Math.PI;
      s.add(sign);
      this.exitSign = sign;
      this.exitLight = this.addLight(new THREE.PointLight(0x55ff66, 2, 7, 1.5));
      this.exitLight.position.set(cx, 2.8, cz - 0.6);
      // Pale light beyond the doors when they open.
      this.outsideLight = this.addLight(new THREE.PointLight(0xd8e0ff, 0, 14, 1.5));
      this.outsideLight.position.set(cx, 1.6, cz + 1.5);
    }

    // Correction cages and the lever cabinet.
    {
      const iron = lambert({ color: 0x2b2b2b });
      const barGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6);
      for (const cg of this.map.cages) {
        const c = tileCenter(cg);
        const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
        const half = TILE * 0.45;
        for (let i = 0; i < 8; i++) {
          const o = -half + (i / 7) * half * 2;
          for (const [x, z] of [[o, -half], [o, half], [-half, o], [half, o]]) {
            const b = occluder(new THREE.Mesh(barGeo, iron)); b.position.set(x, 1.3, z); g.add(b);
          }
        }
        const top = occluder(new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.06, half * 2), iron)); top.position.y = 2.6; g.add(top);
        s.add(g);
      }
      const lc = tileCenter(this.map.lever);
      const cab = occluder(new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.0, 1.4), lambert({ color: 0x3d4440 })));
      cab.position.set(lc.x, 1.0, lc.z); s.add(cab);
      this.leverArm = new THREE.Group(); this.leverArm.position.set(lc.x + 0.72, 1.4, lc.z);
      const arm = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), lambert({ color: 0x777777 })));
      arm.position.y = 0.3; this.leverArm.add(arm);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), lambert({ color: 0x881111, emissive: 0x220000 }));
      knob.position.y = 0.6; this.leverArm.add(knob);
      this.leverArm.rotation.z = 0.6;
      s.add(this.leverArm);
    }

    // Dead ceiling lamps along the corridor, and children's drawings on the walls.
    const shadeGeo = new THREE.ConeGeometry(0.35, 0.3, 10, 1, true);
    const shadeMat = lambert({ color: 0x2a2a20, side: THREE.DoubleSide });
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      if (MAP[z][x] !== '.' && MAP[z][x] !== 'X') continue;
      if ((x * 7 + z * 13) % 11 !== 0) continue;
      const c = tileCenter({ x, z });
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.8), shadeMat); cord.position.set(c.x, WALL_H - 0.4, c.z); s.add(cord);
      const shade = occluder(new THREE.Mesh(shadeGeo, shadeMat)); shade.position.set(c.x, WALL_H - 0.9, c.z); s.add(shade);
    }
    const drawMat = lambert({ map: this.tex.drawing });
    const drawGeo = new THREE.PlaneGeometry(0.55, 0.55);
    let n = 0;
    for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
      if (MAP[z][x] !== '#' || (x * 31 + z * 17) % 9 !== 0) continue;
      for (const [dx, dz, ry] of [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]]) {
        if (MAP[z + dz]?.[x + dx] !== '.') continue;
        const c = tileCenter({ x, z });
        const p = new THREE.Mesh(drawGeo, drawMat);
        p.position.set(c.x + dx * (TILE / 2 + 0.01), 1.75 + ((x + z) % 3) * 0.1, c.z + dz * (TILE / 2 + 0.01));
        p.rotation.y = ry; p.rotation.z = ((x * z) % 5 - 2) * 0.05;
        s.add(p); n++;
        break;
      }
    }

    this.buildPrefect();
  }

  buildPrefect() {
    const g = new THREE.Group();
    const coat = lambert({ color: 0x0d0d0f });
    const body = occluder(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.48, 1.75, 10), coat)); body.position.y = 0.95; g.add(body);
    const shoulders = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.18, 0.3), coat)); shoulders.position.y = 1.8; g.add(shoulders);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 6), coat); neck.position.y = 1.95; g.add(neck);
    const head = new THREE.Group(); head.position.y = 2.18; g.add(head);
    const skull = occluder(new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), coat)); skull.scale.set(1.2, 1, 1); head.add(skull);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.24, 20), lambert({ map: this.tex.mask, emissive: 0x161410 }));
    face.position.z = 0.2; face.scale.set(1.35, 1.0, 1); head.add(face);
    const hat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.04, 0.62), coat); hat.position.y = 0.2; hat.rotation.y = Math.PI / 4; head.add(hat);
    // Long arms; one holds the lantern.
    const armGeo = new THREE.BoxGeometry(0.08, 1.1, 0.08); armGeo.translate(0, -0.55, 0);
    const armL = new THREE.Mesh(armGeo, coat); armL.position.set(-0.36, 1.82, 0); g.add(armL);
    const armR = new THREE.Mesh(armGeo, coat); armR.position.set(0.36, 1.82, 0.1); armR.rotation.x = -0.5; g.add(armR);
    const lantern = new THREE.Group(); lantern.position.set(0, -1.15, 0); armR.add(lantern);
    const glass = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb060 }));
    lantern.add(glass);
    const light = new THREE.PointLight(0xff9a40, 10, 12, 1.4);
    lantern.add(light);
    this.lights.push(light);
    const ghost = motionGhost(new THREE.CylinderGeometry(0.4, 0.5, 2.4, 8)); ghost.position.y = 1.2; g.add(ghost);
    this.scene.add(g);
    this.prefect = { g, head, armL, armR, lantern, light, glass, ghost, phase: 0, x: 0, z: 0, yaw: 0, init: false, state: 'patrol', moving: false };
  }

  makeAvatar(id, name) {
    const g = new THREE.Group();
    const cloth = lambert({ color: 0x6b6b70 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 8), cloth); body.position.y = 0.85; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), lambert({ color: 0xb8a690 })); head.position.y = 1.55; g.add(head);
    const gog = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.1), new THREE.MeshBasicMaterial({ color: 0x1f6a2a })); gog.position.set(0, 1.58, 0.15); g.add(gog);
    const ghost = motionGhost(new THREE.CapsuleGeometry(0.3, 1.0, 2, 6)); ghost.position.y = 0.85; g.add(ghost);
    const label = makeLabel(name); label.position.y = 2.05; g.add(label);
    const carry = new THREE.Group(); carry.position.set(0.25, 1.0, 0.3); g.add(carry);
    this.scene.add(g);
    const a = { g, body, head, ghost, label, carry, carryKind: null, x: 0, z: 0, yaw: 0, init: false, crouch: 0 };
    this.players.set(id, a);
    return a;
  }

  itemMesh(kind) {
    switch (kind) {
      case 'reel': {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.07, 16), lambert({ color: 0x5a5a5a, emissive: 0x0a0a0a }));
        return m;
      }
      case 'bottle': return new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.32, 8), lambert({ color: 0x2f5a3a, emissive: 0x051005 }));
      case 'battery': return new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.1), lambert({ color: 0xb08a20, emissive: 0x1a1200 }));
      case 'key': {
        const g = new THREE.Group();
        const mat = lambert({ color: 0xc8a040, emissive: 0x2a1c00 });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 12), mat); g.add(ring);
        const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.25, 0.03), mat); shaft.position.y = -0.18; g.add(shaft);
        g.rotation.x = Math.PI / 2;
        return g;
      }
    }
    return new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), lambert({ color: 0xffffff }));
  }

  // ---- per-snapshot sync ---------------------------------------------------

  applySnapshot(snap, myId) {
    // Doors
    const openSet = new Set(snap.doors);
    for (const [k, d] of this.doors) {
      const o = openSet.has(k);
      d.target = o ? 1 : 0;
      this.dyn.doors.set(k, o);
    }
    this.dyn.gateOpen = !!snap.gate;
    this.dyn.exitOpen = !!snap.exit;

    // Items
    const seen = new Set();
    for (const it of snap.items) {
      seen.add(it.id);
      let m = this.items.get(it.id);
      if (!m) { m = this.itemMesh(it.k); m.userData.kind = it.k; this.scene.add(m); this.items.set(it.id, m); }
      m.userData.carrier = it.c;
      m.userData.x = it.x; m.userData.z = it.z;
      if (it.c === null) {
        m.visible = true;
        const y = it.k === 'reel' ? 0.04 : it.k === 'bottle' ? 0.16 : 0.06;
        m.position.set(it.x, y, it.z);
        if (it.k === 'reel') m.rotation.set(0, 0, 0);
      } else m.visible = it.c !== myId; // carried by someone else: drawn in their hands
    }
    for (const [id, m] of this.items) if (!seen.has(id)) { this.scene.remove(m); this.items.delete(id); }

    // Bells
    snap.bells.forEach((b, i) => { const bm = this.bellMeshes[i]; if (b && !bm.rung) { bm.rung = true; } });
    this.reelSlots.forEach((r, i) => (r.visible = snap.reels > i));
    if (snap.reels >= 3 && !this.projectorOn) this.projectorOn = 1;

    this.lightsOn = !!snap.lights;
    this.leverProgress = snap.lever;
  }

  ringBell(i) { const b = this.bellMeshes[i]; if (b) b.t = 0; }

  update(dt, snapPlayers, prefectSnap, myId, time) {
    // Doors swing.
    for (const d of this.doors.values()) {
      const prev = d.open;
      d.open += (d.target - d.open) * Math.min(1, dt * 5);
      d.pivot.rotation.y = d.base + d.open * Math.PI * 0.55;
      d.ghost.material.color.setScalar(Math.min(1, Math.abs(d.open - prev) * 40));
    }
    for (const gt of this.gates) {
      const target = this.dyn.gateOpen ? WALL_H - 0.3 : 0;
      const prev = gt.y;
      gt.y += (target - gt.y) * Math.min(1, dt * 4);
      gt.g.position.y = gt.y;
      gt.g.children.forEach(b => b.children[0]?.material.color.setScalar(Math.min(1, Math.abs(gt.y - prev) * 30)));
    }
    for (const e of this.exitDoors) {
      const t = this.dyn.exitOpen ? 1 : 0;
      e.pivot.rotation.y += ((t ? e.side * -1.4 : 0) - e.pivot.rotation.y) * Math.min(1, dt * 1.2);
    }
    this.outsideLight.intensity += ((this.dyn.exitOpen ? 12 : 0) - this.outsideLight.intensity) * Math.min(1, dt);
    this.exitLight.intensity = this.lightsOn ? 2 : 0;
    this.exitSign.material.color.setScalar(this.lightsOn ? 1 : 0.05);

    // Bells swing after ringing.
    for (const b of this.bellMeshes) {
      b.t += dt;
      b.swing.rotation.x = Math.sin(b.t * 6) * 0.5 * Math.exp(-b.t * 0.6);
      b.swing.children[0].children[0].material.color.setScalar(Math.min(1, Math.abs(Math.cos(b.t * 6)) * Math.exp(-b.t * 0.6)));
    }

    // Projector flicker once all reels are in.
    if (this.projectorOn) this.projectorLight.intensity = (this.lightsOn ? 25 : 0) * (0.6 + 0.4 * Math.random());

    // Plate glows faintly when someone stands on it.
    const plateHeld = snapPlayers.some(p => p.hold === 'plate');
    this.plate.material.emissive.setRGB(plateHeld ? 0.05 + 0.03 * Math.random() : 0, plateHeld ? 0.04 : 0, 0);
    this.leverArm.rotation.z = 0.6 - (this.leverProgress || 0) * 1.2;

    // Players.
    const present = new Set();
    for (const p of snapPlayers) {
      if (p.id === myId) continue;
      present.add(p.id);
      const a = this.players.get(p.id);
      if (!a) continue;
      if (!a.init) { a.x = p.x; a.z = p.z; a.yaw = p.yaw; a.init = true; }
      const ox = a.x, oz = a.z;
      a.x += (p.x - a.x) * Math.min(1, dt * 10);
      a.z += (p.z - a.z) * Math.min(1, dt * 10);
      a.yaw += angleDiff(p.yaw, a.yaw) * Math.min(1, dt * 10);
      a.crouch += ((p.c ? 1 : 0) - a.crouch) * Math.min(1, dt * 8);
      a.g.visible = p.hid === null && !p.esc;
      a.g.position.set(a.x, 0, a.z);
      a.g.rotation.y = a.yaw;
      a.g.scale.y = 1 - a.crouch * 0.4;
      const speed = Math.hypot(a.x - ox, a.z - oz) / Math.max(dt, 1e-3);
      a.ghost.material.color.setScalar(Math.min(1, speed / 4));
      a.speed = speed;
      // Carried item.
      const kind = p.carry !== null ? this.items.get(p.carry)?.userData.kind : null;
      if (kind !== a.carryKind) {
        a.carry.clear();
        if (kind) a.carry.add(this.itemMesh(kind));
        a.carryKind = kind;
      }
    }

    // The Prefect.
    const f = this.prefect;
    if (prefectSnap) {
      if (!f.init) { f.x = prefectSnap.x; f.z = prefectSnap.z; f.yaw = prefectSnap.yaw; f.init = true; }
      const ox = f.x, oz = f.z;
      f.x += (prefectSnap.x - f.x) * Math.min(1, dt * 9);
      f.z += (prefectSnap.z - f.z) * Math.min(1, dt * 9);
      f.yaw += angleDiff(prefectSnap.yaw, f.yaw) * Math.min(1, dt * 8);
      f.state = prefectSnap.s;
      const speed = Math.hypot(f.x - ox, f.z - oz) / Math.max(dt, 1e-3);
      f.speed = speed;
      f.phase += dt * (1.5 + speed * 1.6);
      const bob = speed > 0.2 ? Math.abs(Math.sin(f.phase)) * 0.06 : 0;
      f.g.position.set(f.x, bob, f.z);
      f.g.rotation.y = f.yaw;
      f.g.rotation.z = Math.sin(f.phase * 0.5) * 0.03;
      f.armL.rotation.x = Math.sin(f.phase) * 0.35 * Math.min(1, speed / 2);
      f.armR.rotation.x = -0.5 + Math.sin(f.phase + 1) * 0.12;
      f.lantern.rotation.x = Math.sin(f.phase * 1.3) * 0.3;
      // The head tilts when it's listening; snaps forward when it chases.
      const tilt = f.state === 'search' || f.state === 'investigate' ? Math.sin(time * 0.7) * 0.35 : 0;
      f.head.rotation.z += (tilt - f.head.rotation.z) * Math.min(1, dt * 3);
      f.head.rotation.x += ((f.state === 'chase' ? 0.25 : 0) - f.head.rotation.x) * Math.min(1, dt * 4);
      const lanternOn = this.lightsOn ? 1 : 0;
      f.light.intensity = lanternOn * (9 + Math.sin(time * 13) * 1.2 + Math.random() * 1.5);
      f.glass.material.color.setRGB(lanternOn ? 1 : 0.05, lanternOn ? 0.62 : 0.03, lanternOn ? 0.3 : 0.02);
      f.ghost.material.color.setScalar(Math.min(1, speed / 4));
    }
  }

  removeAvatar(id) {
    const a = this.players.get(id);
    if (a) { this.scene.remove(a.g); this.players.delete(id); }
  }
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function makeLabel(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '28px monospace'; g.fillStyle = 'rgba(220,255,220,0.85)'; g.textAlign = 'center';
  g.fillText(text, 128, 40);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(1.0, 0.25, 1);
  return s;
}

export { angleDiff, MASK_LAYER };
