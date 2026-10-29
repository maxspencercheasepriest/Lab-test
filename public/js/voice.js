// Proximity voice chat over WebRTC (peer-to-peer mesh, signalled through the game server).
// Each remote voice goes through two paths:
//   - proximity: positional panner, muffled through walls, fades with distance
//   - radio: crackly bandpassed line everyone hears while the speaker holds R
//
// Negotiation is kept deliberately simple: the lower player id makes one offer with a
// two-way audio transceiver, the higher id answers. The microphone is attached with
// replaceTrack(), which never needs renegotiating.

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

export class Voice {
  constructor(net, sound) {
    this.net = net;
    this.sound = sound;
    this.peers = new Map();  // id -> { pc, audio, chain }
    this.stream = null;
    this.muted = false;
    this.level = 0;
    this.myId = null;
    this.status = 'off';
  }

  get track() { return this.stream?.getAudioTracks()[0] || null; }

  async start() {
    if (this.stream || this.status === 'denied') return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.status = 'on';
      const ctx = this.sound.ctx;
      const src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      for (const p of this.peers.values()) this.attachMic(p.pc);
    } catch (e) {
      console.warn('No microphone:', e);
      this.status = 'denied';
    }
  }

  attachMic(pc) {
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track?.kind !== 'audio') continue;
      t.sender.replaceTrack(this.track).catch(() => {});
    }
  }

  setMuted(m) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach(t => (t.enabled = !m));
  }

  // 0..1 loudness of my own mic, smoothed.
  readLevel() {
    if (!this.analyser || this.muted) return (this.level = 0);
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) s += v * v;
    const rms = Math.sqrt(s / this.buf.length);
    const lvl = Math.min(1, Math.max(0, (rms - 0.015) * 9));
    this.level += (lvl - this.level) * 0.3;
    return this.level;
  }

  // Called whenever the lobby list changes.
  sync(myId, ids) {
    this.myId = myId;
    for (const id of ids) {
      if (id === myId || this.peers.has(id)) continue;
      if (myId < id) this.call(id); // lower id calls, higher id answers
    }
    for (const id of [...this.peers.keys()]) if (!ids.includes(id)) this.drop(id);
  }

  makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = { id, pc, chain: null, audio: null, pendingIce: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (e) => e.candidate && this.net.send({ t: 'rtc', to: id, data: { ice: e.candidate } });
    pc.ontrack = (e) => this.attach(peer, e.streams[0] || new MediaStream([e.track]));
    return peer;
  }

  async call(id) {
    const peer = this.makePeer(id);
    const tr = peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (this.track) tr.sender.replaceTrack(this.track).catch(() => {});
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      this.net.send({ t: 'rtc', to: id, data: { sdp: peer.pc.localDescription } });
    } catch (e) { console.warn('rtc offer', e); }
  }

  async onSignal(from, data) {
    try {
      if (data.sdp?.type === 'offer') {
        if (this.peers.has(from)) this.drop(from); // a fresh call replaces any old one
        const peer = this.makePeer(from);
        const pc = peer.pc;
        await pc.setRemoteDescription(data.sdp);
        for (const t of pc.getTransceivers()) {
          t.direction = 'sendrecv';
          if (this.track) await t.sender.replaceTrack(this.track).catch(() => {});
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this.net.send({ t: 'rtc', to: from, data: { sdp: pc.localDescription } });
        for (const c of peer.pendingIce) await pc.addIceCandidate(c).catch(() => {});
        peer.pendingIce = [];
        return;
      }
      const peer = this.peers.get(from);
      if (!peer) return;
      if (data.sdp?.type === 'answer') {
        if (peer.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(data.sdp);
        for (const c of peer.pendingIce) await peer.pc.addIceCandidate(c).catch(() => {});
        peer.pendingIce = [];
      } else if (data.ice) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.ice).catch(() => {});
        else peer.pendingIce.push(data.ice);
      }
    } catch (e) { console.warn('rtc', e); }
  }

  attach(peer, stream) {
    if (peer.chain) return;
    // Chrome needs the stream attached to a (muted) element before Web Audio will play it.
    const audio = new Audio(); audio.srcObject = stream; audio.muted = true; audio.play().catch(() => {});
    peer.audio = audio;
    const ctx = this.sound.ctx;
    const src = ctx.createMediaStreamSource(stream);
    // Proximity path.
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 2; panner.rolloffFactor = 1.6; panner.maxDistance = 40;
    const muffle = ctx.createBiquadFilter(); muffle.type = 'lowpass'; muffle.frequency.value = 12000;
    const prox = ctx.createGain(); prox.gain.value = 0;
    src.connect(panner).connect(muffle).connect(prox).connect(this.sound.master);
    // Lobby path: flat, full volume.
    const flat = ctx.createGain(); flat.gain.value = 1;
    src.connect(flat).connect(this.sound.master);
    // Radio path.
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 1.2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 4); }
    shaper.curve = curve;
    const radio = ctx.createGain(); radio.gain.value = 0;
    src.connect(bp).connect(shaper).connect(radio).connect(this.sound.master);
    peer.chain = { panner, muffle, prox, flat, radio };
  }

  // Position each voice. mode: 'lobby' | 'game'
  update(mode, remotes) {
    const t = this.sound.ctx?.currentTime || 0;
    for (const peer of this.peers.values()) {
      const c = peer.chain;
      if (!c) continue;
      const r = remotes.get(peer.id);
      if (mode === 'lobby' || !r) {
        c.flat.gain.setTargetAtTime(1, t, 0.1); c.prox.gain.setTargetAtTime(0, t, 0.1); c.radio.gain.setTargetAtTime(0, t, 0.1);
        continue;
      }
      c.flat.gain.setTargetAtTime(0, t, 0.1);
      const p = c.panner;
      if (p.positionX) { p.positionX.setTargetAtTime(r.x, t, 0.05); p.positionY.setTargetAtTime(1.5, t, 0.05); p.positionZ.setTargetAtTime(r.z, t, 0.05); }
      else p.setPosition(r.x, 1.5, r.z);
      c.muffle.frequency.setTargetAtTime(r.muffled ? 500 : 12000, t, 0.15);
      c.prox.gain.setTargetAtTime(r.escaped ? 0 : (r.inLocker ? 0.6 : 1), t, 0.1);
      c.radio.gain.setTargetAtTime(r.radio ? 0.9 : 0, t, 0.03);
    }
  }

  drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    p.pc.close();
    p.audio?.pause();
    this.peers.delete(id);
  }
}
