// All sound is synthesised in the browser — no audio files.
// Positional sounds go through HRTF panners; anything behind a wall gets muffled.

export class Sound {
  constructor() {
    this.ctx = null;
  }

  async init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.comp = ctx.createDynamicsCompressor();
    this.master.connect(this.comp).connect(ctx.destination);

    // Big damp-corridor reverb.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.8, 2.2);
    this.reverbIn = ctx.createGain(); this.reverbIn.gain.value = 0.55;
    this.reverbIn.connect(this.reverb).connect(this.master);

    this.noiseBuf = this.makeNoise(2);
    this.ambience();
    this.heart = this.makeHeartbeat();
    this.chase = this.makeChaseLayer();
    this.breath = this.makeBreath();
  }

  resume() { this.ctx?.state === 'suspended' && this.ctx.resume(); }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  makeNoise(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.5; }
    return buf;
  }

  setListener(x, y, z, yaw) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(x, t); l.positionY.setValueAtTime(y, t); l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(0, t); l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
    } else {
      l.setPosition(x, y, z); l.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  // A positional output chain: panner -> muffle filter -> master (+ reverb send).
  spatial(x, y, z, { muffled = false, refDistance = 2, rolloff = 1.4, maxDistance = 60, reverb = 0.35 } = {}) {
    const ctx = this.ctx;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = refDistance; p.rolloffFactor = rolloff; p.maxDistance = maxDistance;
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = muffled ? 380 : 12000;
    const g = ctx.createGain(); g.gain.value = muffled ? 0.7 : 1;
    p.connect(f).connect(g).connect(this.master);
    const send = ctx.createGain(); send.gain.value = reverb * (muffled ? 1.4 : 1);
    g.connect(send).connect(this.reverbIn);
    return { input: p, panner: p, filter: f, out: g };
  }

  noiseBurst(dest, { dur = 0.1, freq = 800, q = 1, type = 'lowpass', gain = 0.5, attack = 0.002, when = 0 } = {}) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  tone(dest, { freq = 440, dur = 1, type = 'sine', gain = 0.2, attack = 0.005, when = 0, detune = 0, glide = 0 } = {}) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * glide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ---- beds ---------------------------------------------------------------

  ambience() {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0.16;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140;
    for (const f of [41, 41.6, 61.7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start();
    }
    lp.connect(g).connect(this.master);
    // Air in the building.
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 300; bp.Q.value = 0.7;
    const ng = ctx.createGain(); ng.gain.value = 0.035;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.02;
    lfo.connect(lfoG).connect(ng.gain); lfo.start();
    n.connect(bp).connect(ng).connect(this.master); n.start();
    this.ambGain = g;
  }

  makeHeartbeat() {
    const g = this.ctx.createGain(); g.gain.value = 0; g.connect(this.master);
    return { g, next: 0, rate: 1 };
  }

  makeChaseLayer() {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 4;
    // Dissonant string-ish cluster.
    for (const f of [110, 116.5, 155.6, 164.8, 233]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const v = ctx.createOscillator(); v.frequency.value = 4 + Math.random() * 3;
      const vg = ctx.createGain(); vg.gain.value = 3; v.connect(vg).connect(o.frequency); v.start();
      o.connect(lp); o.start();
    }
    lp.connect(g).connect(this.master);
    g.connect(this.reverbIn);
    return { g, lp };
  }

  makeBreath() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(bp).connect(g).connect(this.master); src.start();
    return { g, bp, phase: 0 };
  }

  // Called every frame with how scared/out of breath the player is.
  updateBeds(dt, { fear, exhaustion, chasing, inLocker, prefectNear }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Heartbeat.
    const h = this.heart;
    const target = Math.max(fear * 0.9, inLocker ? prefectNear * 0.9 : 0);
    h.g.gain.setTargetAtTime(target * 0.9, t, 0.3);
    h.next -= dt;
    if (h.next <= 0 && target > 0.05) {
      const bpm = 70 + target * 90;
      h.next = 60 / bpm;
      this.tone(h.g, { freq: 52, dur: 0.18, type: 'sine', gain: 0.9, glide: 0.6 });
      this.tone(h.g, { freq: 46, dur: 0.16, type: 'sine', gain: 0.6, glide: 0.6, when: 0.16 });
    }
    // Chase strings.
    this.chase.g.gain.setTargetAtTime(chasing ? 0.05 + fear * 0.06 : 0, t, chasing ? 0.4 : 2.5);
    this.chase.lp.frequency.setTargetAtTime(500 + fear * 2400, t, 0.5);
    // Breathing: out of breath, or holding it together in a locker.
    const b = this.breath;
    const amount = Math.max(exhaustion, inLocker ? 0.35 + prefectNear * 0.5 : 0, fear * 0.4);
    b.phase += dt * (1.2 + amount * 2.6);
    const s = Math.max(0, Math.sin(b.phase));
    b.g.gain.setTargetAtTime(amount * s * 0.12, t, 0.05);
    b.bp.frequency.setTargetAtTime(Math.sin(b.phase) > 0 ? 1100 : 700, t, 0.1);
  }

  // ---- one-shots ----------------------------------------------------------

  footstep(pos, { heavy = false, volume = 1, muffled = false, self = false } = {}) {
    if (!this.ctx) return;
    const dest = self ? this.selfOut() : this.spatial(pos.x, 0.1, pos.z, { muffled, refDistance: heavy ? 3 : 1.5 }).input;
    const v = volume * (heavy ? 1.2 : 0.5);
    this.noiseBurst(dest, { dur: heavy ? 0.22 : 0.09, freq: heavy ? 260 : 900, q: 0.8, gain: v });
    this.noiseBurst(dest, { dur: 0.03, freq: heavy ? 1200 : 3200, type: 'bandpass', q: 1.5, gain: v * 0.35 });
    if (heavy) this.tone(dest, { freq: 60, dur: 0.25, gain: v * 0.5, glide: 0.5 });
  }

  selfOut() {
    if (!this._self) {
      this._self = this.ctx.createGain(); this._self.gain.value = 0.5;
      this._self.connect(this.master);
      const s = this.ctx.createGain(); s.gain.value = 0.2; this._self.connect(s).connect(this.reverbIn);
    }
    return this._self;
  }

  door(pos, open, muffled) {
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 1.2, pos.z, { muffled, refDistance: 3 }).input;
    if (open) {
      // Creak: a resonant sweep.
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(70 + Math.random() * 40, t);
      o.frequency.linearRampToValueAtTime(140 + Math.random() * 80, t + 0.6);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 12;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.08); g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      o.connect(f).connect(g).connect(out); o.start(t); o.stop(t + 0.9);
    } else {
      this.noiseBurst(out, { dur: 0.25, freq: 300, gain: 0.9 });
      this.tone(out, { freq: 80, dur: 0.3, gain: 0.4, glide: 0.6 });
    }
  }

  bell(pos) {
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 2, pos.z, { refDistance: 12, rolloff: 0.6, reverb: 1 }).input;
    const base = 196 + Math.random() * 40;
    for (const [m, g, d] of [[0.5, 0.25, 6], [1, 0.35, 5], [1.19, 0.18, 3.5], [1.5, 0.15, 3], [2, 0.12, 2.5], [2.74, 0.08, 1.6], [3.76, 0.05, 1.2]]) {
      this.tone(out, { freq: base * m, dur: d, gain: g, attack: 0.002 });
    }
    this.noiseBurst(out, { dur: 0.05, freq: 3000, type: 'bandpass', gain: 0.5 });
  }

  smash(pos, muffled) {
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 0.2, pos.z, { muffled, refDistance: 4 }).input;
    this.noiseBurst(out, { dur: 0.35, freq: 2500, type: 'highpass', gain: 0.9 });
    for (let i = 0; i < 8; i++) this.tone(out, { freq: 2500 + Math.random() * 4000, dur: 0.15 + Math.random() * 0.3, gain: 0.08, when: Math.random() * 0.35 });
  }

  locker(pos, muffled) {
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 1.2, pos.z, { muffled, refDistance: 3 }).input;
    for (const f of [320, 487, 715, 1130]) this.tone(out, { freq: f * (0.95 + Math.random() * 0.1), dur: 0.5, gain: 0.08, type: 'square' });
    this.noiseBurst(out, { dur: 0.12, freq: 900, gain: 0.6 });
  }

  clank(pos) { // lever / gate machinery
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 1.2, pos.z, { refDistance: 3 }).input;
    this.noiseBurst(out, { dur: 0.2, freq: 600, gain: 0.8 });
    this.tone(out, { freq: 140, dur: 0.6, gain: 0.25, type: 'triangle', glide: 0.7 });
  }

  hum(pos, on) {
    if (!this.ctx) return;
    if (!this._hum) {
      const s = this.spatial(pos.x, 0.2, pos.z, { refDistance: 2 });
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 50;
      const o2 = this.ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 100.5;
      const g = this.ctx.createGain(); g.gain.value = 0;
      o.connect(g); o2.connect(g); g.connect(s.input); o.start(); o2.start();
      this._hum = { g, s };
    }
    this._hum.g.gain.setTargetAtTime(on ? 0.06 : 0, this.ctx.currentTime, 0.2);
  }

  projector(pos) {
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 1.2, pos.z, { refDistance: 3 }).input;
    for (let i = 0; i < 60; i++) this.noiseBurst(out, { dur: 0.02, freq: 2000, type: 'bandpass', q: 3, gain: 0.25, when: i * 0.05 });
  }

  caught() {
    if (!this.ctx) return;
    const out = this.master;
    this.noiseBurst(out, { dur: 1.2, freq: 400, gain: 1.2, attack: 0.001 });
    this.tone(out, { freq: 70, dur: 2, gain: 0.8, glide: 0.4, type: 'sawtooth' });
    this.tone(out, { freq: 1900, dur: 1.5, gain: 0.1, type: 'sine', glide: 0.9 });
  }

  sting() { // something just saw you
    if (!this.ctx) return;
    const out = this.master;
    for (const f of [98, 103.8, 138.6, 196, 207.6]) this.tone(out, { freq: f, dur: 2.2, gain: 0.07, type: 'sawtooth', attack: 0.01 });
    this.noiseBurst(out, { dur: 0.6, freq: 5000, type: 'highpass', gain: 0.3 });
  }

  creak() { // the building settling, somewhere
    if (!this.ctx) return;
    const a = Math.random() * Math.PI * 2;
    const out = this.spatial(Math.cos(a) * 15, 2, Math.sin(a) * 15, { muffled: true, refDistance: 6 }).input;
    this.noiseBurst(out, { dur: 0.8, freq: 200 + Math.random() * 300, q: 6, type: 'bandpass', gain: 0.6, attack: 0.2 });
  }

  chime() { // tannoy ding-dong
    if (!this.ctx) return;
    const out = this.ctx.createGain(); out.gain.value = 0.6; out.connect(this.master); out.connect(this.reverbIn);
    this.tone(out, { freq: 659, dur: 1.4, gain: 0.25 });
    this.tone(out, { freq: 523, dur: 1.8, gain: 0.25, when: 0.55 });
    this.noiseBurst(out, { dur: 2.6, freq: 3000, type: 'bandpass', gain: 0.03, attack: 0.1 });
  }

  squelch() {
    if (!this.ctx) return;
    this.noiseBurst(this.master, { dur: 0.12, freq: 2200, type: 'bandpass', q: 2, gain: 0.25 });
  }

  prefectBreath(pos, muffled) {
    if (!this.ctx) return;
    const out = this.spatial(pos.x, 2.1, pos.z, { muffled, refDistance: 1.5, rolloff: 2 }).input;
    this.noiseBurst(out, { dur: 1.4, freq: 500, q: 3, type: 'bandpass', gain: 0.5, attack: 0.5 });
    this.tone(out, { freq: 90 + Math.random() * 20, dur: 1.2, gain: 0.05, type: 'sawtooth', attack: 0.4 });
  }
}
