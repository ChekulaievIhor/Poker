// Сетевой стол: всё решает сервер, клиент только шлёт действия и проигрывает события.
import { Emitter } from './emitter.js';

export function defaultServerUrl() {
  const loc = globalThis.location;
  if (loc && /^https?:$/.test(loc.protocol) && loc.host) {
    return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
  }
  return 'ws://localhost:8080/ws';
}

export function playerToken() {
  try {
    let t = localStorage.getItem('holdem.token');
    if (!t) {
      const b = new Uint8Array(18);
      crypto.getRandomValues(b);
      t = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('holdem.token', t);
    }
    return t;
  } catch {
    return 'tmp' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

export class NetError extends Error {
  constructor(code, params = {}) { super(code); this.code = code; this.params = params; }
}

export class NetTable extends Emitter {
  /** url — адрес WebSocket-сервера или функция, создающая транспорт с интерфейсом WebSocket (P2P). */
  constructor(url, profile) {
    super();
    this.mode = 'online';
    this.url = url;
    this.openTransport = typeof url === 'function' ? url : () => new WebSocket(url);
    this.onDestroy = null;
    this.me = profile; // { name, avatar, lang }
    this.myId = null;
    this.tableId = null;
    this.snapState = null;
    this.pending = new Map();
    this.reqSeq = 0;
    this.closed = false;
    this.clock = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = this.openTransport(); } catch (e) { reject(new NetError('connectFailed')); return; }
      this.ws = ws;
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new NetError('connectFailed')); }, 20000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.request({ type: 'hello', token: playerToken(), ...this.me }).then((m) => {
          this.myId = m.playerId;
          resolve();
        }, reject);
      };
      ws.onerror = (e) => { clearTimeout(timer); reject(new NetError((e && e.code) || 'connectFailed')); };
      ws.onclose = () => this.onClose();
      ws.onmessage = (e) => { try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  // Запрос с ответом: сервер возвращает тот же reqId
  request(msg) {
    const reqId = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.send({ ...msg, reqId });
      setTimeout(() => {
        if (this.pending.has(reqId)) { this.pending.delete(reqId); reject(new NetError('connectFailed')); }
      }, 10000);
    });
  }

  async create(opts) { const m = await this.request({ type: 'create', ...opts }); this.onJoined(m); }
  async join(tableId) { const m = await this.request({ type: 'join', tableId: String(tableId).trim().toUpperCase() }); this.onJoined(m); }

  onJoined(m) {
    this.tableId = m.tableId;
    this.snapState = m.state;
    this.emit('state', this.snap());
  }

  snap() {
    if (!this.snapState) return null;
    return { ...this.snapState, myId: this.myId, mode: this.mode, tableId: this.tableId, clock: this.clockInfo() };
  }

  onMessage(m) {
    if (m.reqId && this.pending.has(m.reqId)) {
      const p = this.pending.get(m.reqId);
      this.pending.delete(m.reqId);
      if (m.type === 'error') p.reject(new NetError(m.code, m.params));
      else p.resolve(m);
      return;
    }
    switch (m.type) {
      case 'event':
        this.snapState = m.state;
        this.emit('event', m.ev, this.snap());
        break;
      case 'state':
        this.snapState = m.state;
        this.emit('state', this.snap());
        break;
      case 'clock':
        this.clock = m.seat >= 0 ? { seat: m.seat, total: m.total, endsAt: performance.now() + m.remaining } : null;
        this.emit('clock', this.clockInfo());
        break;
      case 'toast': this.emit('toast', m.key, m.params || {}); break;
      case 'error': this.emit('toast', 'err.' + m.code, m.params || {}); break;
      case 'timeout': this.emit('timeout', m.id, m.name); break;
      case 'rtc': this.emit('rtc', m.from, m.data); break;
    }
  }

  clockInfo() {
    if (!this.clock) return null;
    return { seat: this.clock.seat, total: this.clock.total, paused: false, remaining: Math.max(0, this.clock.endsAt - performance.now()) };
  }

  async onClose() {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.emit('status', 'disconnected');
    // Переподключаемся с тем же токеном — сервер вернёт нас на то же место
    for (let attempt = 0; !this.closed; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(1000 + attempt * 1000, 5000)));
      if (this.closed) return;
      try {
        await this.connect();
        if (this.tableId) await this.join(this.tableId);
        this.reconnecting = false;
        this.emit('status', 'reconnected');
        return;
      } catch { /* следующая попытка */ }
    }
  }

  idle() {}
  pauseClock() {}
  resumeClock() {}
  act(action) { this.send({ type: 'act', action }); }
  transfer(to, amount) { this.send({ type: 'transfer', to, amount }); return { queued: null }; }
  async profile(id) { const m = await this.request({ type: 'profile', playerId: id }); return m.profile; }
  setMedia(cam, mic) { this.send({ type: 'media', cam, mic }); }
  rtc(to, data) { this.send({ type: 'rtc', to, data }); }

  destroy() {
    this.closed = true;
    this.send({ type: 'leave' });
    const ws = this.ws;
    // даём «leave» уйти, потом закрываем соединение и (у хоста) сам стол
    setTimeout(() => { try { ws && ws.close(); } catch {} if (this.onDestroy) this.onDestroy(); }, 200);
  }
}
