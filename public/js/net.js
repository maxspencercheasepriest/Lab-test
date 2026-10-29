// WebSocket connection to the game server.
export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
  }
  on(t, fn) { this.handlers.set(t, fn); }
  // addr: '' for the server this page came from, or a friend's address such as
  // "192.168.1.20:8080", "203.0.113.5:8080" or "https://my-game.onrender.com".
  static url(addr) {
    if (!addr) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    let a = addr.trim().replace(/\/+$/, '');
    if (/^https:\/\//i.test(a)) return 'wss://' + a.slice(8);
    if (/^http:\/\//i.test(a)) return 'ws://' + a.slice(7);
    if (/^wss?:\/\//i.test(a)) return a;
    if (!/:\d+$/.test(a) && !/\.(com|net|org|io|app|dev|uk)$/i.test(a)) a += ':8080';
    return 'ws://' + a;
  }
  connect(addr = '') {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(Net.url(addr));
      const timer = setTimeout(() => { this.ws.onclose = null; this.ws.close(); reject(new Error('timeout')); }, 6000);
      this.ws.addEventListener('open', () => clearTimeout(timer));
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => { clearTimeout(timer); reject(e); };
      this.ws.onclose = () => this.handlers.get('close')?.();
      this.ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        this.handlers.get(m.t)?.(m);
      };
    });
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
}
