// Night-vision tunnel: a small green circle of amplified vision in the middle — the only
// place you can really see. Around it, your naked eye: almost black. Only real light
// (the Prefect's lantern, the exit sign) and the faintest hint of movement get through.
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tMask;
uniform sampler2D tPeri;
uniform sampler2D tArms;
uniform vec2 resolution;
uniform float time;
uniform float radius;      // circle radius as a fraction of screen height
uniform float nvOn;        // 0..1 (flickers when the battery dies)
uniform float battery;
uniform float fear;        // 0..1, tightens and shakes the circle
uniform float hide;        // 0 none, 1 locker slats, 2 under a bed
uniform float caught;      // 0..1, red correction tint
uniform float hurt;        // 0..1, low health
uniform float hitFlash;    // red flash on a hit
uniform float downed;      // 0..1
uniform float flash;       // white flash (bells, smashes)
uniform float fade;        // fade to black
uniform float periGainLo;
uniform float periGainHi;
uniform vec2 jitter;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = vUv;
  float aspect = resolution.x / resolution.y;
  vec2 c = (uv - 0.5 - jitter) * vec2(aspect, 1.0);
  float r = length(c);

  float rad = radius * (1.0 - 0.25 * fear) * (1.0 - 0.25 * downed);
  float edge = 0.03 + 0.02 * fear;
  float inner = 1.0 - smoothstep(rad - edge, rad, r);

  if (hide > 1.5) {
    // Under a bed: a thin letterbox between the mattress and the floor.
    float band = smoothstep(0.075, 0.06, abs(uv.y - 0.47)) * smoothstep(0.36, 0.3, abs(uv.x - 0.5));
    inner = band;
  } else if (hide > 0.5) {
    // Locker: three slats.
    float y = (uv.y - 0.5) * 9.0;
    float slat = smoothstep(0.42, 0.30, abs(fract(y + 0.5) - 0.5));
    float band = step(abs(uv.y - 0.5), 0.17) * step(abs(uv.x - 0.5), 0.24);
    inner = slat * band;
  }

  vec3 scene = texture2D(tScene, uv).rgb;
  vec4 arms = texture2D(tArms, uv);
  float l = mix(lum(scene), lum(arms.rgb) * 1.3, arms.a);

  // --- Night vision (inside the circle) ---
  float grain = hash(uv * resolution + fract(time * 61.0) * 100.0);
  float gain = mix(1.0, 16.0, nvOn);
  float amp = 1.0 - exp(-l * gain);
  amp = pow(amp, 1.15);
  amp += (grain - 0.5) * mix(0.03, 0.13, nvOn);
  amp *= 0.92 + 0.08 * sin(uv.y * resolution.y * 1.4);           // scanlines
  amp *= 0.96 + 0.04 * sin(time * 50.0);                          // tube flicker
  amp *= 1.0 - smoothstep(0.0, rad, r) * 0.35;                    // lens vignette
  vec3 nvCol = mix(vec3(l) * 0.9, vec3(0.20, 1.0, 0.35) * amp, nvOn);
  nvCol += vec3(0.015, 0.05, 0.025) * nvOn * battery;              // phosphor glow

  // --- Periphery: the naked eye in the dark. Nearly nothing. ---
  vec2 px = 1.0 / resolution;
  float b = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    b += lum(texture2D(tPeri, uv + vec2(float(i), float(j)) * px * 6.0).rgb);
  }
  b /= 9.0;
  float t = smoothstep(rad, 0.95, r);
  float peri = 1.0 - exp(-b * mix(periGainLo, periGainHi, t));
  float motion = texture2D(tMask, uv).r;
  float flick = 0.5 + 0.5 * hash(vec2(floor(time * 24.0), uv.y * 7.0));
  peri += motion * flick * mix(0.0, 0.035, t);
  peri += lum(arms.rgb) * arms.a * 0.012;                         // your own hands, barely
  peri += (hash(uv * resolution * 0.5 + time) - 0.5) * 0.008;
  vec3 periCol = vec3(0.55, 0.6, 0.72) * max(peri, 0.0);

  vec3 col = mix(periCol, nvCol, inner);
  // Thin dark ring around the tube.
  col *= 1.0 - (smoothstep(rad - edge * 1.6, rad - edge * 0.6, r) * (1.0 - smoothstep(rad - edge * 0.6, rad + 0.01, r))) * 0.6 * step(hide, 0.5);

  // Hurt: the world drains of colour and the edges bleed.
  float vig = smoothstep(0.25, 0.9, r);
  col = mix(col, vec3(lum(col)) * vec3(1.1, 0.75, 0.7), hurt * 0.6);
  col += vec3(0.35, 0.0, 0.0) * vig * (hurt * (0.6 + 0.4 * sin(time * 3.0)) + hitFlash * 2.0);
  col = mix(col, col * vec3(1.4, 0.25, 0.2) + vec3(0.06, 0.0, 0.0), caught);
  col += flash;
  col *= 1.0 - fade;
  col = pow(max(col, 0.0), vec3(1.0 / 1.7)); // to display gamma
  gl_FragColor = vec4(col, 1.0);
}
`;

export class NightVision {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = 0.55; // render at reduced resolution for a crunchy look
    const opts = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true };
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, opts);
    this.armsRT = new THREE.WebGLRenderTarget(4, 4, opts);
    this.maskRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.periRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.uniforms = {
      tScene: { value: this.sceneRT.texture },
      tMask: { value: this.maskRT.texture },
      tPeri: { value: this.periRT.texture },
      tArms: { value: this.armsRT.texture },
      resolution: { value: new THREE.Vector2(1, 1) },
      time: { value: 0 }, radius: { value: 0.2 }, nvOn: { value: 1 }, battery: { value: 1 },
      fear: { value: 0 }, hide: { value: 0 }, caught: { value: 0 }, flash: { value: 0 },
      hurt: { value: 0 }, hitFlash: { value: 0 }, downed: { value: 0 },
      fade: { value: 0 }, jitter: { value: new THREE.Vector2() },
      periGainLo: { value: 0.05 }, periGainHi: { value: 0.3 },
    };
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, depthTest: false, depthWrite: false })
    );
    this.quad.frustumCulled = false;
    this.postScene = new THREE.Scene();
    this.postScene.add(this.quad);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.flash = 0;
    this.hit = 0;
  }

  setSize(w, h) {
    const sw = Math.max(1, Math.floor(w * this.scale)), sh = Math.max(1, Math.floor(h * this.scale));
    this.sceneRT.setSize(sw, sh);
    this.armsRT.setSize(sw, sh);
    this.maskRT.setSize(Math.max(1, sw >> 2), Math.max(1, sh >> 2));
    this.periRT.setSize(Math.max(1, sw >> 2), Math.max(1, sh >> 2));
    this.uniforms.resolution.value.set(sw, sh);
  }

  // lights: all lights (switched off for the motion mask).
  // eye: { ir, ambient, ambientLevel } — the naked-eye pass hides the IR.
  // arms: { scene, camera } or null.
  render(scene, camera, lights, dt, state, eye, arms) {
    const u = this.uniforms;
    const r = this.renderer;
    u.time.value += dt;

    // 1. Motion mask: only moving things (layer 1) and the level (black, unlit) for occlusion.
    const vis = lights.map(l => l.visible);
    lights.forEach(l => (l.visible = false));
    const fog = scene.fog;
    scene.fog = null;
    camera.layers.set(1);
    r.setRenderTarget(this.maskRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, camera);
    camera.layers.set(0);
    lights.forEach((l, i) => (l.visible = vis[i]));
    scene.fog = fog;

    // 2. Naked-eye periphery: no infrared.
    if (eye) {
      const irVis = eye.ir.visible, amb = eye.ambient.intensity;
      eye.ir.visible = false;
      eye.ambient.intensity = eye.ambientLevel;
      r.setRenderTarget(this.periRT);
      r.clear();
      r.render(scene, camera);
      eye.ir.visible = irVis;
      eye.ambient.intensity = amb;
    }

    // 3. Scene through the night-vision tube.
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(scene, camera);

    // 4. Your arms, on their own layer with transparency.
    r.setRenderTarget(this.armsRT);
    r.setClearColor(0x000000, 0);
    r.clear();
    if (arms) r.render(arms.scene, arms.camera);
    r.setClearColor(0x000000, 1);

    // 5. Composite.
    const k = (rate) => Math.min(1, dt * rate);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.hit = Math.max(0, this.hit - dt * 2.2);
    u.flash.value = this.flash;
    u.hitFlash.value = this.hit;
    u.nvOn.value = state.nvOn;
    u.battery.value = state.battery;
    u.fear.value += (state.fear - u.fear.value) * k(3);
    u.hide.value = state.hide === 'bed' ? 2 : state.hide ? 1 : 0;
    u.caught.value += ((state.caught ? 0.55 : 0) - u.caught.value) * k(2);
    u.hurt.value += ((state.hurt || 0) - u.hurt.value) * k(2);
    u.downed.value += ((state.downed ? 1 : 0) - u.downed.value) * k(2);
    u.fade.value += (state.fade - u.fade.value) * k(4);
    const batR = state.battery < 0.25 ? 0.6 + state.battery * 1.6 : 1;
    u.radius.value = 0.2 * batR;
    const f = Math.max(u.fear.value, state.shake || 0);
    u.jitter.value.set(
      (Math.sin(u.time.value * 23.0) + Math.sin(u.time.value * 37.0)) * 0.004 * f,
      (Math.cos(u.time.value * 29.0) + Math.sin(u.time.value * 19.0)) * 0.004 * f,
    );
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);
  }
}
