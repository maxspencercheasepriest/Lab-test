// Builds the level from the shared ASCII map and keeps the moving parts in sync.
import * as THREE from 'three';
import { MAP, W, H, TILE, WALL_H, parseMap, tileCenter, roomAt } from '/shared/map.js';
import { tkey } from '/shared/grid.js';

const MASK_LAYER = 1;

function lambert(opts) { return new THREE.MeshLambertMaterial(opts); }
function occluder(mesh) { mesh.layers.enable(MASK_LAYER); return mesh; }

// A silhouette only drawn into the motion mask; brightness = how fast it moves.
function motionGhost(geo) {
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
  m.layers.set(MASK_LAYER);
  return m;
}

export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class World {
  constructor(scene, tex) {
    this.scene = scene;
    this.tex = tex;
    this.map = parseMap();
    this.lights = [];
    this.doors = new Map();     // tkey -> { pivot, open, target }
    this.items = new Map();     // id -> mesh
    this.players = new Map();   // id -> avatar
    this.enemies = new Map();   // id -> enemy visual
    this.dyn = { doors: new Map(), gateOpen: false, exitOpen: false };
    for (const d of this.map.doors) this.dyn.doors.set(tkey(d.x, d.z), false);
    this.lightsOn = true;
    this.build();
  }

  addLight(l) { this.lights.push(l); this.scene.add(l); return l; }

  build() {
    const s = this.scene;
    const T = this.tex;
    T.floor.repeat.set(W, H); T.ceiling.repeat.set(W, H);

    this.ambient = this.addLight(new THREE.AmbientLight(0xffffff, 0.03));

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
      let n = false;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (open(x + dx, z + dz)) n = true;
      if (n) wallTiles.push({ x, z });
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

    // Lockers.
    const lockerGeo = new THREE.BoxGeometry(TILE * 0.96, 2.5, TILE * 0.96);
    const lt = T.locker.clone(); lt.repeat.set(3, 1); lt.needsUpdate = true;
    const lockerMat = lambert({ map: lt });
    for (const l of this.map.lockers) {
      const c = tileCenter(l);
      const m = occluder(new THREE.Mesh(lockerGeo, lockerMat));
      m.position.set(c.x, 1.25, c.z);
      s.add(m);
    }

    // Iron beds — you can hide underneath.
    const iron = lambert({ color: 0x2b2b2d });
    const mattress = lambert({ color: 0x8e8a7c });
    const sheet = lambert({ color: 0xb8b2a2 });
    for (const b of this.map.beds) {
      const c = tileCenter(b);
      // Beds run away from the nearest wall.
      const alongZ = MAP[b.z - 1]?.[b.x] === '#' || MAP[b.z + 1]?.[b.x] === '#';
      const g = new THREE.Group(); g.position.set(c.x, 0, c.z); if (!alongZ) g.rotation.y = Math.PI / 2;
      const top = occluder(new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.18, 2.1), mattress)); top.position.y = 0.62; g.add(top);
      const sh = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.05, 1.3), sheet); sh.position.set(0, 0.72, 0.35); g.add(sh);
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.3), sheet); pillow.position.set(0, 0.76, -0.8); g.add(pillow);
      for (const sx of [-0.48, 0.48]) for (const sz of [-1.02, 1.02]) {
        const leg = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.05, sz < 0 ? 1.1 : 0.8, 0.05), iron));
        leg.position.set(sx, (sz < 0 ? 1.1 : 0.8) / 2, sz); g.add(leg);
      }
      const head = occluder(new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.05), iron)); head.position.set(0, 1.08, -1.02); g.add(head);
      // A sheet hanging to the floor on one side, so you're hidden.
      const drape = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.55, 1.9), sheet)); drape.position.set(0.5, 0.36, 0.05); g.add(drape);
      s.add(g);
    }

    // Desks (classroom, study, projection room) and pews (chapel).
    const wood = lambert({ color: 0x3a2a1c });
    const darkWood = lambert({ color: 0x2a1d12 });
    for (const d of this.map.desks) {
      const c = tileCenter(d);
      const room = roomAt(d.x, d.z)?.name;
      const g = new THREE.Group(); g.position.set(c.x, 0, c.z);
      if (room === 'Chapel') {
        const seat = occluder(new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.08, 0.6), darkWood)); seat.position.y = 0.48; g.add(seat);
        const back = occluder(new THREE.Mesh(new THREE.BoxGeometry(TILE, 0.7, 0.08), darkWood)); back.position.set(0, 0.85, 0.3); g.add(back);
        for (const sx of [-1.1, 1.1]) { const end = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.65), darkWood)); end.position.set(sx, 0.5, 0); g.add(end); }
      } else {
        const top = occluder(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.9), wood)); top.position.y = 0.78; g.add(top);
        for (const sx of [-0.62, 0.62]) for (const sz of [-0.38, 0.38]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.78, 0.05), wood); leg.position.set(sx, 0.39, sz); g.add(leg); }
        const chair = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.05, 0.45), wood)); chair.position.set(0.1, 0.45, 0.75); g.add(chair);
        const cb = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.04), wood); cb.position.set(0.1, 0.72, 0.97); g.add(cb);
        g.rotation.y = ((d.x + d.z) % 3 - 1) * 0.08;
      }
      s.add(g);
    }

    // Broken glass on the floor.
    const shardMat = new THREE.MeshLambertMaterial({ color: 0xbfd8d8, emissive: 0x0a1414 });
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const t of this.map.glass) {
      const c = tileCenter(t);
      for (let i = 0; i < 14; i++) {
        const sz = 0.05 + rnd() * 0.12;
        const sh = new THREE.Mesh(new THREE.BoxGeometry(sz, 0.008, sz * (0.4 + rnd())), shardMat);
        sh.position.set(c.x + (rnd() - 0.5) * TILE * 0.9, 0.006, c.z + (rnd() - 0.5) * TILE * 0.9);
        sh.rotation.y = rnd() * 6;
        s.add(sh);
      }
    }

    // Chapel bells on wooden frames.
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
      for (const dz of [-0.3, 0.3, 0]) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 18), lambert({ color: 0x333333 }));
        r.rotation.x = Math.PI / 2; r.rotation.z = Math.PI / 2; r.position.set(0, dz === 0 ? 1.85 : 1.6, dz); r.visible = false; g.add(r); this.reelSlots.push(r);
      }
      s.add(g);
      this.projectorLight = this.addLight(new THREE.SpotLight(0xfff2d0, 0, 18, 0.35, 0.6, 1));
      this.projectorLight.position.set(c.x, 1.2, c.z);
      this.projectorLight.target.position.set(c.x + 10, 1.4, c.z);
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
      this.outsideLight = this.addLight(new THREE.PointLight(0xd8e0ff, 0, 14, 1.5));
      this.outsideLight.position.set(cx, 1.6, cz + 1.5);
    }

    // Correction cages and the lever cabinet.
    {
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
      this.leverArm = new THREE.Group(); this.leverArm.position.set(lc.x - 0.72, 1.4, lc.z);
      const arm = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), lambert({ color: 0x777777 })));
      arm.position.y = 0.3; this.leverArm.add(arm);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), lambert({ color: 0x881111, emissive: 0x220000 }));
      knob.position.y = 0.6; this.leverArm.add(knob);
      this.leverArm.rotation.z = -0.6;
      s.add(this.leverArm);
    }

    // Dead ceiling lamps, pipes in the boiler room, and children's drawings on the walls.
    const shadeGeo = new THREE.ConeGeometry(0.35, 0.3, 10, 1, true);
    const shadeMat = lambert({ color: 0x2a2a20, side: THREE.DoubleSide });
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      if (MAP[z][x] !== '.') continue;
      if ((x * 7 + z * 13) % 11 !== 0) continue;
      const c = tileCenter({ x, z });
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.8), shadeMat); cord.position.set(c.x, WALL_H - 0.4, c.z); s.add(cord);
      const shade = occluder(new THREE.Mesh(shadeGeo, shadeMat)); shade.position.set(c.x, WALL_H - 0.9, c.z); s.add(shade);
    }
    const pipeMat = lambert({ color: 0x4a3c30 });
    for (let x = 12; x <= 30; x++) {
      const c = tileCenter({ x, z: 21 });
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, TILE, 8), pipeMat);
      pipe.rotation.z = Math.PI / 2; pipe.position.set(c.x, WALL_H - 0.35, c.z - TILE / 2 + 0.2); s.add(pipe);
    }
    const drawMat = lambert({ map: this.tex.drawing });
    const drawGeo = new THREE.PlaneGeometry(0.55, 0.55);
    for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
      if (MAP[z][x] !== '#' || (x * 31 + z * 17) % 9 !== 0) continue;
      for (const [dx, dz, ry] of [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]]) {
        if (MAP[z + dz]?.[x + dx] !== '.') continue;
        const c = tileCenter({ x, z });
        const p = new THREE.Mesh(drawGeo, drawMat);
        p.position.set(c.x + dx * (TILE / 2 + 0.01), 1.75 + ((x + z) % 3) * 0.1, c.z + dz * (TILE / 2 + 0.01));
        p.rotation.y = ry; p.rotation.z = ((x * z) % 5 - 2) * 0.05;
        s.add(p);
        break;
      }
    }
  }

  // ---- enemies -------------------------------------------------------------

  makePrefect() {
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
    return { kind: 'prefect', g, head, armL, armR, lantern, light, glass, ghost };
  }

  makeOrderly() {
    // Stooped, white-coated, a sack over the head and a cosh in one hand.
    const g = new THREE.Group();
    const coat = lambert({ color: 0xa8a49a });
    const dark = lambert({ color: 0x1c1a18 });
    const sack = lambert({ color: 0x6e5a40 });
    const spine = new THREE.Group(); spine.position.y = 0.95; spine.rotation.x = 0.25; g.add(spine);
    const body = occluder(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.1, 8), coat)); body.position.y = 0.2; spine.add(body);
    for (const sx of [-0.15, 0.15]) { const leg = occluder(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.85, 0.16), dark)); leg.position.set(sx, 0.42, 0); g.add(leg); }
    const head = new THREE.Group(); head.position.set(0, 0.9, 0.05); spine.add(head);
    const bag = occluder(new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 7), sack)); bag.scale.set(1, 1.2, 1); head.add(bag);
    const tie = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.02, 4, 10), dark); tie.rotation.x = Math.PI / 2; tie.position.y = -0.2; head.add(tie);
    for (const sx of [-0.08, 0.08]) { const eye = new THREE.Mesh(new THREE.CircleGeometry(0.035, 8), new THREE.MeshBasicMaterial({ color: 0x000000 })); eye.position.set(sx, 0.04, 0.215); head.add(eye); }
    const armGeo = new THREE.BoxGeometry(0.12, 0.95, 0.12); armGeo.translate(0, -0.47, 0);
    const armL = new THREE.Mesh(armGeo, coat); armL.position.set(-0.4, 0.65, 0); spine.add(armL);
    const armR = new THREE.Mesh(armGeo, coat); armR.position.set(0.4, 0.65, 0); spine.add(armR);
    const cosh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.6, 6), dark); cosh.position.set(0, -1.1, 0.12); cosh.rotation.x = 0.4; armR.add(cosh);
    const ghost = motionGhost(new THREE.CylinderGeometry(0.4, 0.45, 2.0, 8)); ghost.position.y = 1.0; g.add(ghost);
    return { kind: 'orderly', g, head, armL, armR, spine, ghost };
  }

  syncEnemies(list) {
    const seen = new Set();
    for (const e of list) {
      seen.add(e.id);
      let v = this.enemies.get(e.id);
      if (!v) {
        v = e.k === 'prefect' ? this.makePrefect() : this.makeOrderly();
        Object.assign(v, { x: e.x, z: e.z, yaw: e.yaw, phase: Math.random() * 6, speed: 0, swing: 0, state: e.s, stepAcc: 0 });
        this.scene.add(v.g);
        this.enemies.set(e.id, v);
      }
      v.target = e;
    }
    for (const [id, v] of this.enemies) if (!seen.has(id)) this.removeEnemy(id);
  }

  removeEnemy(id) {
    const v = this.enemies.get(id);
    if (!v) return;
    this.scene.remove(v.g);
    if (v.light) this.lights.splice(this.lights.indexOf(v.light), 1);
    this.enemies.delete(id);
  }

  clearEnemies() { for (const id of [...this.enemies.keys()]) this.removeEnemy(id); }

  swing(id) { const v = this.enemies.get(id); if (v) v.swing = 0.5; }

  // ---- avatars & items -------------------------------------------------------

  makeAvatar(id, name) {
    const g = new THREE.Group();
    const inner = new THREE.Group(); g.add(inner);
    const cloth = lambert({ color: 0x6b6b70 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 8), cloth); body.position.y = 0.85; inner.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), lambert({ color: 0xb8a690 })); head.position.y = 1.55; inner.add(head);
    const gog = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.1), new THREE.MeshBasicMaterial({ color: 0x1f6a2a })); gog.position.set(0, 1.58, 0.15); inner.add(gog);
    const ghost = motionGhost(new THREE.CapsuleGeometry(0.3, 1.0, 2, 6)); ghost.position.y = 0.85; inner.add(ghost);
    const label = makeLabel(name); label.position.y = 2.05; g.add(label);
    const carry = new THREE.Group(); carry.position.set(0.25, 1.0, 0.3); inner.add(carry);
    this.scene.add(g);
    const a = { g, inner, body, head, ghost, label, carry, carryKind: null, x: 0, z: 0, yaw: 0, init: false, crouch: 0, down: 0 };
    this.players.set(id, a);
    return a;
  }

  itemMesh(kind) {
    switch (kind) {
      case 'reel': return new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.07, 16), lambert({ color: 0x5a5a5a, emissive: 0x0a0a0a }));
      case 'bottle': return new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.32, 8), lambert({ color: 0x2f5a3a, emissive: 0x051005 }));
      case 'brick': return new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.11), lambert({ color: 0x7a3b2a, emissive: 0x0a0402 }));
      case 'battery': return new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.1), lambert({ color: 0xb08a20, emissive: 0x1a1200 }));
      case 'syringe': {
        const g = new THREE.Group();
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.18, 8), new THREE.MeshLambertMaterial({ color: 0xd8f0e0, emissive: 0x0a2010 }));
        barrel.rotation.z = Math.PI / 2; g.add(barrel);
        const fluid = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 8), new THREE.MeshBasicMaterial({ color: 0x55ff88 }));
        fluid.rotation.z = Math.PI / 2; fluid.position.x = 0.03; g.add(fluid);
        const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.08, 4), lambert({ color: 0xcccccc }));
        needle.rotation.z = Math.PI / 2; needle.position.x = 0.13; g.add(needle);
        return g;
      }
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
    const openSet = new Set(snap.doors);
    for (const [k, d] of this.doors) {
      const o = openSet.has(k);
      d.target = o ? 1 : 0;
      this.dyn.doors.set(k, o);
    }
    this.dyn.gateOpen = !!snap.gate;
    this.dyn.exitOpen = !!snap.exit;

    const seen = new Set();
    for (const it of snap.items) {
      seen.add(it.id);
      let m = this.items.get(it.id);
      if (!m) { m = this.itemMesh(it.k); m.userData.kind = it.k; this.scene.add(m); this.items.set(it.id, m); }
      m.userData.carrier = it.c;
      m.userData.x = it.x; m.userData.z = it.z;
      if (it.c === null) {
        m.visible = true;
        const y = { reel: 0.04, bottle: 0.16, brick: 0.04, syringe: 0.03 }[it.k] ?? 0.06;
        m.position.set(it.x, y, it.z);
      } else m.visible = false;
    }
    for (const [id, m] of this.items) if (!seen.has(id)) { this.scene.remove(m); this.items.delete(id); }

    snap.bells.forEach((b, i) => { this.bellMeshes[i].rung = !!b; });
    this.reelSlots.forEach((r, i) => (r.visible = snap.reels > i));
    if (snap.reels >= 3 && !this.projectorOn) this.projectorOn = 1;
    this.lightsOn = !!snap.lights;
    this.leverProgress = snap.lever;
    this.syncEnemies(snap.en);
  }

  ringBell(i) { const b = this.bellMeshes[i]; if (b) b.t = 0; }

  update(dt, snapPlayers, myId, time) {
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

    for (const b of this.bellMeshes) {
      b.t += dt;
      b.swing.rotation.x = Math.sin(b.t * 6) * 0.5 * Math.exp(-b.t * 0.6);
      b.swing.children[0].children[0].material.color.setScalar(Math.min(1, Math.abs(Math.cos(b.t * 6)) * Math.exp(-b.t * 0.6)));
    }
    if (this.projectorOn) this.projectorLight.intensity = (this.lightsOn ? 25 : 0) * (0.6 + 0.4 * Math.random());
    const plateHeld = snapPlayers.some(p => p.hold === 'plate');
    this.plate.material.emissive.setRGB(plateHeld ? 0.05 + 0.03 * Math.random() : 0, plateHeld ? 0.04 : 0, 0);
    this.leverArm.rotation.z = -0.6 + (this.leverProgress || 0) * 1.2;
    for (const [, m] of this.items) if (m.visible && (m.userData.kind === 'syringe' || m.userData.kind === 'key')) m.rotation.y += dt;

    // Other players.
    for (const p of snapPlayers) {
      if (p.id === myId) continue;
      const a = this.players.get(p.id);
      if (!a) continue;
      if (!a.init) { a.x = p.x; a.z = p.z; a.yaw = p.yaw; a.init = true; }
      const ox = a.x, oz = a.z;
      a.x += (p.x - a.x) * Math.min(1, dt * 10);
      a.z += (p.z - a.z) * Math.min(1, dt * 10);
      a.yaw += angleDiff(p.yaw, a.yaw) * Math.min(1, dt * 10);
      a.crouch += ((p.c ? 1 : 0) - a.crouch) * Math.min(1, dt * 8);
      a.down += ((p.dn ? 1 : 0) - a.down) * Math.min(1, dt * 5);
      a.g.visible = p.hid === null && !p.esc;
      a.g.position.set(a.x, 0, a.z);
      a.g.rotation.y = a.yaw;
      a.inner.scale.y = 1 - a.crouch * 0.4 * (1 - a.down);
      a.inner.rotation.x = a.down * 1.45;          // lying on the floor
      a.inner.position.y = a.down * 0.25;
      a.inner.position.z = a.down * 0.6;
      a.label.position.y = 2.05 - a.down * 1.5;
      const speed = Math.hypot(a.x - ox, a.z - oz) / Math.max(dt, 1e-3);
      a.ghost.material.color.setScalar(Math.min(1, speed / 4));
      const kind = p.carry !== null ? this.items.get(p.carry)?.userData.kind : p.th !== null ? this.items.get(p.th)?.userData.kind : null;
      if (kind !== a.carryKind) {
        a.carry.clear();
        if (kind) a.carry.add(this.itemMesh(kind));
        a.carryKind = kind;
      }
    }

    // Enemies.
    for (const v of this.enemies.values()) {
      const e = v.target;
      if (!e) continue;
      const ox = v.x, oz = v.z;
      v.x += (e.x - v.x) * Math.min(1, dt * 9);
      v.z += (e.z - v.z) * Math.min(1, dt * 9);
      v.yaw += angleDiff(e.yaw, v.yaw) * Math.min(1, dt * 8);
      v.state = e.s;
      const speed = Math.hypot(v.x - ox, v.z - oz) / Math.max(dt, 1e-3);
      v.speed = speed;
      v.phase += dt * (1.5 + speed * 1.6);
      v.swing = Math.max(0, v.swing - dt);
      const bob = speed > 0.2 ? Math.abs(Math.sin(v.phase)) * 0.06 : 0;
      v.g.position.set(v.x, bob, v.z);
      v.g.rotation.y = v.yaw;
      const stunned = e.s === 'stunned';
      const listening = e.s === 'search' || e.s === 'investigate';
      if (v.kind === 'prefect') {
        v.g.rotation.z = stunned ? Math.sin(time * 9) * 0.08 : Math.sin(v.phase * 0.5) * 0.03;
        v.armL.rotation.x = e.s === 'grab' ? -1.4 : Math.sin(v.phase) * 0.35 * Math.min(1, speed / 2);
        v.armR.rotation.x = e.s === 'grab' ? -1.3 : -0.5 + Math.sin(v.phase + 1) * 0.12;
        v.lantern.rotation.x = Math.sin(v.phase * 1.3) * 0.3;
        const tilt = listening ? Math.sin(time * 0.7) * 0.35 : 0;
        v.head.rotation.z += ((stunned ? 0.6 : tilt) - v.head.rotation.z) * Math.min(1, dt * 3);
        v.head.rotation.x += ((e.s === 'chase' ? 0.25 : stunned ? 0.5 : 0) - v.head.rotation.x) * Math.min(1, dt * 4);
        const on = this.lightsOn ? 1 : 0;
        v.light.intensity = on * (9 + Math.sin(time * 13) * 1.2 + Math.random() * 1.5) * (stunned ? 0.4 : 1);
        v.glass.material.color.setRGB(on ? 1 : 0.05, on ? 0.62 : 0.03, on ? 0.3 : 0.02);
      } else {
        v.spine.rotation.x = stunned ? 0.9 : e.s === 'chase' ? 0.45 : 0.25;
        v.armL.rotation.x = Math.sin(v.phase) * 0.4 * Math.min(1, speed / 2);
        // Wind-up and swing of the cosh.
        if (e.s === 'attack') v.armR.rotation.x += (-2.6 - v.armR.rotation.x) * Math.min(1, dt * 10);
        else if (v.swing > 0) v.armR.rotation.x = -2.6 + (1 - v.swing / 0.5) * 3.2;
        else v.armR.rotation.x += (Math.sin(v.phase + Math.PI) * 0.4 * Math.min(1, speed / 2) - v.armR.rotation.x) * Math.min(1, dt * 6);
        v.head.rotation.z = listening ? Math.sin(time * 1.3 + v.phase) * 0.4 : stunned ? 0.5 : 0;
      }
      v.ghost.material.color.setScalar(Math.min(1, speed / 4));
    }
  }

  removeAvatar(id) {
    const a = this.players.get(id);
    if (a) { this.scene.remove(a.g); this.players.delete(id); }
  }
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

export { MASK_LAYER };
