// WebSocket connection to the game server.
export class Net {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
  }
  on(t, fn) { this.handlers.set(t, fn); }
  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      this.ws = new WebSocket(`${proto}://${location.host}`);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => this.handlers.get('close')?.();
      this.ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        this.handlers.get(m.t)?.(m);
      };
    });
  }
  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
}
