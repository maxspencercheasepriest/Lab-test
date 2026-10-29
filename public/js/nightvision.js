// Night-vision tunnel: a small green circle of amplified vision in the middle,
// dark naked-eye periphery around it that gets *more* sensitive towards the edges
// and catches movement — like rod cells do.
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
uniform vec2 resolution;
uniform float time;
uniform float radius;      // circle radius as a fraction of screen height
uniform float nvOn;        // 0..1 (flickers when the battery dies)
uniform float battery;
uniform float fear;        // 0..1, tightens and shakes the circle
uniform float locker;      // 0..1, view through locker slats
uniform float caught;      // 0..1, red correction tint
uniform float flash;       // white flash (bells, smashes)
uniform float fade;        // fade to black
uniform vec2 jitter;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = vUv;
  float aspect = resolution.x / resolution.y;
  vec2 c = (uv - 0.5 - jitter) * vec2(aspect, 1.0);
  float r = length(c);

  float rad = radius * (1.0 - 0.28 * fear);
  float edge = 0.035 + 0.02 * fear;
  float inner = 1.0 - smoothstep(rad - edge, rad, r);

  // Locker: replace the circle with three horizontal slats.
  if (locker > 0.5) {
    float y = (uv.y - 0.5) * 9.0;
    float slat = smoothstep(0.42, 0.30, abs(fract(y + 0.5) - 0.5));
    float band = step(abs(uv.y - 0.5), 0.17) * step(abs(uv.x - 0.5), 0.26);
    inner = slat * band;
  }

  vec3 scene = texture2D(tScene, uv).rgb;
  float l = lum(scene);

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
  nvCol += vec3(0.02, 0.06, 0.03) * nvOn * battery;               // phosphor glow

  // --- Periphery: dim, blurry, colourless, but brighter towards the edges ---
  // Naked-eye view (no infrared), rendered small so it's naturally blurry.
  vec2 px = 1.0 / resolution;
  float b = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    b += lum(texture2D(tPeri, uv + vec2(float(i), float(j)) * px * 6.0).rgb);
  }
  b /= 9.0;
  float t = smoothstep(rad, 0.95, r);
  float periGain = mix(0.6, 3.5, t);
  float peri = 1.0 - exp(-b * periGain);
  // Motion: things that move flicker pale at the edge of your sight.
  float motion = texture2D(tMask, uv).r;
  float flick = 0.55 + 0.45 * hash(vec2(floor(time * 24.0), uv.y * 7.0));
  peri += motion * flick * mix(0.04, 0.28, t);
  peri += (hash(uv * resolution * 0.5 + time) - 0.5) * 0.035;
  vec3 periCol = vec3(0.62, 0.68, 0.80) * peri;

  vec3 col = mix(periCol, nvCol, inner);
  // Thin dark ring around the tube.
  col *= 1.0 - (smoothstep(rad - edge * 1.6, rad - edge * 0.6, r) * (1.0 - smoothstep(rad - edge * 0.6, rad + 0.01, r))) * 0.6 * (1.0 - locker);

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
    this.maskRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.periRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.uniforms = {
      tScene: { value: this.sceneRT.texture },
      tMask: { value: this.maskRT.texture },
      tPeri: { value: this.periRT.texture },
      resolution: { value: new THREE.Vector2(1, 1) },
      time: { value: 0 }, radius: { value: 0.2 }, nvOn: { value: 1 }, battery: { value: 1 },
      fear: { value: 0 }, locker: { value: 0 }, caught: { value: 0 }, flash: { value: 0 },
      fade: { value: 0 }, jitter: { value: new THREE.Vector2() },
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
    this.blackout = 0;
  }

  setSize(w, h) {
    const sw = Math.max(1, Math.floor(w * this.scale)), sh = Math.max(1, Math.floor(h * this.scale));
    this.sceneRT.setSize(sw, sh);
    this.maskRT.setSize(Math.max(1, sw >> 2), Math.max(1, sh >> 2));
    this.periRT.setSize(Math.max(1, sw >> 2), Math.max(1, sh >> 2));
    this.uniforms.resolution.value.set(sw, sh);
  }

  // lights: all lights (switched off for the motion mask).
  // eye: { ir, ambient, ambientLevel } — the naked-eye pass hides the IR and lifts ambient a little.
  render(scene, camera, lights, dt, state, eye) {
    const u = this.uniforms;
    const r = this.renderer;
    u.time.value += dt;

    // 1. Motion mask: only moving things (layer 1) and the level (black, unlit) for occlusion.
    const vis = lights.map(l => l.visible);
    lights.forEach(l => (l.visible = false));
    const bg = scene.background, fog = scene.fog;
    scene.fog = null;
    camera.layers.set(1);
    r.setRenderTarget(this.maskRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, camera);
    camera.layers.set(0);
    lights.forEach((l, i) => (l.visible = vis[i]));
    scene.fog = fog; scene.background = bg;

    // 2. Naked-eye periphery: no infrared, eyes adapted to the dark.
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

    // 4. Composite.
    this.flash = Math.max(0, this.flash - dt * 2.5);
    u.flash.value = this.flash;
    u.nvOn.value = state.nvOn;
    u.battery.value = state.battery;
    u.fear.value += (state.fear - u.fear.value) * Math.min(1, dt * 3);
    u.locker.value = state.locker ? 1 : 0;
    u.caught.value += ((state.caught ? 0.55 : 0) - u.caught.value) * Math.min(1, dt * 2);
    u.fade.value += (state.fade - u.fade.value) * Math.min(1, dt * 4);
    const batR = state.battery < 0.25 ? 0.6 + state.battery * 1.6 : 1;
    u.radius.value = 0.2 * batR;
    const f = u.fear.value;
    u.jitter.value.set(
      (Math.sin(u.time.value * 23.0) + Math.sin(u.time.value * 37.0)) * 0.004 * f,
      (Math.cos(u.time.value * 29.0) + Math.sin(u.time.value * 19.0)) * 0.004 * f,
    );
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);
  }
}
