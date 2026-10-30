// First-person arms. They live in their own little scene (so they never clip into walls)
// and are composited into the night-vision tube: your hands sit at the bottom of the green
// circle, carry things into view, reach for doors, pump when you run and fight when grabbed.
import * as THREE from 'three';

const lerp = (a, b, t) => a + (b - a) * t;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function lambert(color) { return new THREE.MeshLambertMaterial({ color }); }

function makeHand(side, skin) {
  const hand = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.028, 0.075), skin);
  hand.add(palm);
  const fingers = [];
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Group();
    f.position.set(-0.03 + i * 0.02, 0, -0.04);
    f.rotation.y = (i - 1.5) * 0.08;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.034), skin);
    seg.position.z = -0.017;
    f.add(seg);
    const tip = new THREE.Group(); tip.position.z = -0.034; f.add(tip);
    const seg2 = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.013, 0.03), skin);
    seg2.position.z = -0.015; tip.add(seg2);
    f.userData.tip = tip;
    hand.add(f);
    fingers.push(f);
  }
  const thumb = new THREE.Group();
  thumb.position.set(-side * 0.045, -0.005, -0.01);
  const tseg = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.05), skin);
  tseg.position.z = -0.025;
  thumb.add(tseg);
  thumb.rotation.y = side * 0.6;
  hand.add(thumb);
  return { hand, fingers, thumb };
}

export class Arms {
  constructor(itemMesh) {
    this.itemMesh = itemMesh;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.01, 5);
    this.scene.add(this.camera);
    // Lit by the goggles' own infrared lamp, right next to them.
    this.light = new THREE.PointLight(0xffffff, 0.08, 3, 1.4);
    this.light.position.set(0, 0.05, 0.05);
    this.camera.add(this.light);
    this.camera.add(new THREE.AmbientLight(0xffffff, 0.006));
    const key = new THREE.DirectionalLight(0xffffff, 0.065); key.position.set(-0.6, 1, 0.4);
    this.camera.add(key); this.key = key;

    const sleeve = lambert(0x24262a);
    const cuff = lambert(0x111214);
    const skin = lambert(0xc2a28c);
    this.arms = [-1, 1].map((side) => {
      const root = new THREE.Group();
      const fore = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1), sleeve);
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.056, 0.025), cuff);
      root.add(fore); root.add(band);
      const h = makeHand(side, skin);
      root.add(h.hand);
      const grip = new THREE.Group(); // where held items go
      grip.position.set(0, -0.02, -0.06);
      h.hand.add(grip);
      this.camera.add(root);
      return { side, root, fore, band, ...h, grip, elbow: V(side * 0.19, -0.36, -0.12), pos: V(side * 0.09, -0.11, -0.42), curl: 0.6 };
    });
    this.heldKind = null;
    this.t = 0;
    this.throwT = 0;
    this.reachT = 0;
    this.hitT = 0;
    this.visible = true;
    this.tune = { roll: 0.5, pitch: 0.9, y: -0.075, dx: 0.01 };
  }

  setAspect(a) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }

  reach() { this.reachT = 0.45; }
  throwIt() { this.throwT = 0.5; }
  flinch() { this.hitT = 0.4; }

  setHeld(kind) {
    if (kind === this.heldKind) return;
    this.heldKind = kind;
    const g = this.arms[1].grip;
    g.clear();
    if (kind) {
      const m = this.itemMesh(kind);
      m.scale.setScalar(0.38);
      if (kind === 'reel') { m.rotation.set(Math.PI / 2, 0, 0); m.position.set(0, -0.01, -0.05); }
      if (kind === 'key') { m.rotation.set(0, 0, 0); m.position.set(0, 0, -0.04); }
      if (kind === 'bottle' || kind === 'brick') m.position.set(0, 0.02, -0.03);
      g.add(m);
    }
  }

  // s: { moving, running, crouch, bob, mode, held, holdKind, sway:{x,y} }
  // mode: 'normal' | 'grab' | 'hide' | 'downed' | 'hold' | 'heal' | 'caught' | 'hidden'
  update(dt, s) {
    this.t += dt;
    const t = this.t;
    this.throwT = Math.max(0, this.throwT - dt);
    this.reachT = Math.max(0, this.reachT - dt);
    this.hitT = Math.max(0, this.hitT - dt);
    const [L, R] = this.arms;
    const show = !['hidden', 'caught', 'escaped'].includes(s.mode);
    for (const a of this.arms) a.root.visible = show;
    if (!show) return;

    // Base poses: hands rest at the bottom of the NV circle.
    let lp = V(-0.09 + this.tune.dx * -1, this.tune.y, -0.4), rp = V(0.085 + this.tune.dx, this.tune.y + 0.002, -0.4);
    let lc = 0.2, rc = 0.2;
    const breathe = Math.sin(t * 1.6) * 0.004;
    lp.y += breathe; rp.y += breathe;

    if (s.moving) {
      const amp = s.running ? 0.06 : 0.015;
      const ph = s.bob;
      lp.y += Math.sin(ph) * amp; rp.y += Math.sin(ph + Math.PI) * amp;
      lp.z += Math.cos(ph) * amp * 1.4; rp.z += Math.cos(ph + Math.PI) * amp * 1.4;
      if (s.running) { lp.x -= 0.02; rp.x += 0.02; lp.y -= 0.04; rp.y -= 0.04; }
    }
    if (s.crouch) { lp.y += 0.02; rp.y += 0.02; lp.z += 0.03; rp.z += 0.03; }
    if (s.held) { rp = V(0.06, -0.065, -0.4); rc = 0.9; }

    switch (s.mode) {
      case 'grab': { // fighting it off
        const shake = Math.sin(t * 38) * 0.025;
        lp = V(-0.09 + shake, -0.03, -0.3); rp = V(0.09 - shake, -0.02 + shake, -0.3);
        lc = 0.3; rc = 0.3;
        break;
      }
      case 'downed': { // clawing along the floor
        const ph = t * 3;
        lp = V(-0.1, -0.12 + Math.max(0, Math.sin(ph)) * 0.04, -0.42 + Math.sin(ph) * 0.06);
        rp = V(0.1, -0.12 + Math.max(0, Math.sin(ph + Math.PI)) * 0.04, -0.42 + Math.sin(ph + Math.PI) * 0.06);
        lc = 0.2; rc = 0.2;
        break;
      }
      case 'hold': { // pushing a lever / both hands on a friend
        lp = V(-0.06, -0.07, -0.46 + Math.sin(t * 6) * 0.01); rp = V(0.06, -0.07, -0.46 + Math.sin(t * 6 + 1) * 0.01);
        lc = 0.9; rc = 0.9;
        break;
      }
      case 'heal': {
        lp = V(-0.03, -0.08, -0.36); rp = V(0.04, -0.05, -0.38);
        lc = 0.4; rc = 0.95;
        break;
      }
      case 'plate': {
        lp.y -= 0.02; rp.y -= 0.02;
        break;
      }
    }

    // Reaching for a door / picking something up.
    if (this.reachT > 0) {
      const k = Math.sin((1 - this.reachT / 0.45) * Math.PI);
      rp.lerp(V(0.03, -0.04, -0.58), k);
      rc = lerp(rc, 0.25, k);
    }
    // Throwing: wind back, then fling forward.
    if (this.throwT > 0) {
      const p = 1 - this.throwT / 0.5;
      if (p < 0.4) rp.lerp(V(0.2, -0.02, -0.15), p / 0.4);
      else rp.lerp(V(0.02, -0.02, -0.65), (p - 0.4) / 0.6);
    }
    // Got hit: hands jerk.
    if (this.hitT > 0) {
      const k = this.hitT / 0.4;
      lp.add(V(-0.04, 0.05, 0.08).multiplyScalar(k)); rp.add(V(0.04, 0.05, 0.08).multiplyScalar(k));
    }
    // Mouse sway: hands lag behind your view a touch.
    const sx = s.sway?.x || 0, sy = s.sway?.y || 0;
    lp.x += sx; rp.x += sx; lp.y += sy; rp.y += sy;

    const k = Math.min(1, dt * 14);
    L.pos.lerp(lp, k); R.pos.lerp(rp, k);
    L.curl = lerp(L.curl, lc, k); R.curl = lerp(R.curl, rc, k);
    for (const a of this.arms) this.pose(a);
  }

  pose(a) {
    const from = a.elbow, to = a.pos;
    const dir = to.clone().sub(from);
    const len = dir.length();
    a.fore.scale.z = len;
    a.fore.position.copy(from).addScaledVector(dir, 0.5);
    a.fore.lookAt(this.camera.localToWorld(to.clone()));
    // lookAt works in world space; the camera sits at the origin with no rotation, so this holds.
    a.band.position.copy(from).addScaledVector(dir, 0.93);
    a.band.quaternion.copy(a.fore.quaternion);
    a.hand.position.copy(to).addScaledVector(dir.normalize(), 0.05);
    a.hand.quaternion.copy(a.fore.quaternion);
    a.hand.rotateZ(-a.side * this.tune.roll);
    a.hand.rotateX(this.tune.pitch);
    for (const f of a.fingers) { f.rotation.x = -a.curl * 1.1; f.userData.tip.rotation.x = -a.curl * 1.3; }
    a.thumb.rotation.x = -a.curl * 0.6;
  }
}
