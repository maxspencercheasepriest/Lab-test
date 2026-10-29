// Procedural canvas textures — no image files needed.
import * as THREE from 'three';

function canvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const rnd = (() => { let s = 1337; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();

function grime(g, w, h, n, alpha) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(0,0,0,${alpha * rnd()})`;
    const r = 4 + rnd() * 40;
    g.beginPath(); g.ellipse(rnd() * w, rnd() * h, r, r * (0.4 + rnd()), rnd() * 3, 0, Math.PI * 2); g.fill();
  }
}

export function makeTextures() {
  const wall = canvas(128, 128, (g, w, h) => {
    // Plaster above, wooden dado panelling below, like an old school corridor.
    g.fillStyle = '#9a9384'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},0,0.04)`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    g.fillStyle = '#4a3a2a'; g.fillRect(0, h * 0.62, w, h * 0.38);
    g.fillStyle = '#3a2c1f'; g.fillRect(0, h * 0.6, w, 5);
    for (let x = 0; x < w; x += 32) { g.fillStyle = '#2c2117'; g.fillRect(x, h * 0.65, 2, h * 0.33); g.strokeStyle = '#5a4733'; g.strokeRect(x + 5, h * 0.68, 22, h * 0.26); }
    // Damp stains running down.
    for (let i = 0; i < 5; i++) {
      const x = rnd() * w, len = 20 + rnd() * 60;
      const grd = g.createLinearGradient(0, 0, 0, len);
      grd.addColorStop(0, 'rgba(40,35,20,0.35)'); grd.addColorStop(1, 'rgba(40,35,20,0)');
      g.fillStyle = grd; g.fillRect(x, 0, 3 + rnd() * 8, len);
    }
    grime(g, w, h, 12, 0.12);
  });
  const floor = canvas(128, 128, (g, w, h) => {
    // Checkerboard lino, worn.
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#2a2a28' : '#77736a';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
    grime(g, w, h, 30, 0.2);
    for (let i = 0; i < 40; i++) { g.strokeStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); const x = rnd() * w, y = rnd() * h; g.moveTo(x, y); g.lineTo(x + rnd() * 20 - 10, y + rnd() * 20 - 10); g.stroke(); }
  });
  const ceiling = canvas(64, 64, (g, w, h) => {
    g.fillStyle = '#6d6a62'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#4d4a44'; for (let i = 0; i <= w; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    grime(g, w, h, 6, 0.25);
  });
  const door = canvas(64, 128, (g, w, h) => {
    g.fillStyle = '#4b3523'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2b1d12'; g.lineWidth = 3;
    g.strokeRect(8, 10, w - 16, 44); g.strokeRect(8, 66, w - 16, 52);
    g.fillStyle = '#1a1a1a'; g.fillRect(10, 14, w - 20, 34); // dark glass pane
    g.fillStyle = '#b8a060'; g.fillRect(w - 12, 62, 6, 6);  // brass handle
    grime(g, w, h, 6, 0.2);
  });
  const locker = canvas(64, 128, (g, w, h) => {
    g.fillStyle = '#58605a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b1d1c';
    for (let i = 0; i < 4; i++) g.fillRect(14, 12 + i * 7, w - 28, 3);  // vents
    g.fillStyle = '#9a9a90'; g.fillRect(w - 14, 60, 4, 14);
    g.strokeStyle = '#2f3330'; g.lineWidth = 2; g.strokeRect(3, 3, w - 6, h - 6);
    grime(g, w, h, 10, 0.25);
  });
  const mask = canvas(128, 128, (g, w, h) => {
    // The Prefect's face: too wide, too smooth.
    g.fillStyle = '#e8e4d8'; g.beginPath(); g.ellipse(64, 64, 62, 58, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000';
    g.beginPath(); g.ellipse(36, 54, 13, 6, -0.15, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(92, 54, 13, 6, 0.15, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(22, 88); g.quadraticCurveTo(64, 112, 106, 88); g.quadraticCurveTo(64, 98, 22, 88); g.fill();
    g.strokeStyle = 'rgba(80,60,40,0.4)'; g.lineWidth = 1;
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(rnd() * 128, rnd() * 128); g.lineTo(rnd() * 128, rnd() * 128); g.stroke(); }
  });
  const sign = canvas(128, 32, (g, w, h) => {
    g.fillStyle = '#0a2a0a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#7dff7d'; g.font = 'bold 22px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('E X I T', w / 2, h / 2 + 1);
  });
  const drawing = canvas(64, 64, (g, w, h) => {
    // A child's drawing pinned to the wall.
    g.fillStyle = '#d8d0b8'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#222'; g.lineWidth = 2;
    g.beginPath(); g.arc(32, 20, 8, 0, Math.PI * 2); g.moveTo(32, 28); g.lineTo(32, 48); g.moveTo(20, 36); g.lineTo(44, 36); g.moveTo(32, 48); g.lineTo(24, 60); g.moveTo(32, 48); g.lineTo(40, 60); g.stroke();
    g.fillStyle = '#000'; g.fillRect(8, 6, 10, 50);
    g.fillStyle = '#e8e4d8'; g.beginPath(); g.arc(13, 10, 6, 0, Math.PI * 2); g.fill();
  });
  for (const t of [wall, floor, ceiling]) t.anisotropy = 1;
  return { wall, floor, ceiling, door, locker, mask, sign, drawing };
}
