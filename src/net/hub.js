// Логика игрового стола, общая для двух вариантов сети:
//  • Node-сервер (server/server.js) — соединения по WebSocket;
//  • браузер хоста (src/ui/p2p.js)  — соединения WebRTC через PeerJS, без своего сервера.
// Транспорт — любой объект с send(string) и close(). Протокол один и тот же.
import { HoldemGame, PokerError } from '../engine/game.js';
import { decide, PERSONALITIES } from '../bots/bot.js';
import { defaultRandomInt as randomInt } from '../engine/cards.js';

const SEAT_ORDER = [0, 3, 2, 4, 1, 5];  // рассаживаем так, чтобы игроки были напротив
const BLINDS = { '5/10': [5, 10], '10/20': [10, 20], '25/50': [25, 50], '50/100': [50, 100] };
const STACKS = [1000, 2000, 5000, 10000];
const BOT_NAMES = ['Marco', 'Irina', 'Dan', 'Oksana', 'Leo', 'Vera', 'Taras', 'Niko', 'Lena', 'Omar', 'Sofia', 'Jan'];
export const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих I/1, O/0

const clean = (s, max = 14) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const hex = (n) => Array.from({ length: n }, () => randomInt(16).toString(16)).join('');
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

export function randomTableId() {
  return Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join('');
}

/** Статистика в памяти (браузер хоста). Сервер подставляет хранилище с файлом. */
export class MemoryStats {
  constructor() { this.data = {}; }
  get(token) { return (this.data[token] ||= { name: '', hands: 0, wins: 0, biggest: 0 }); }
  touch() {}
}

export class Hub {
  constructor({
    stats = new MemoryStats(), turnMs = 30_000, graceMs = 1500, nextHandMs = 4500,
    botDelay = [1200, 2600], awayRemoveMs = 5 * 60_000, emptyRoomMs = 10 * 60_000,
    fixedTableId = null, // P2P: у стола хоста ID совпадает с адресом хоста в PeerJS
  } = {}) {
    this.opts = { turnMs, graceMs, nextHandMs, botDelay, awayRemoveMs, emptyRoomMs };
    this.stats = stats;
    this.fixedTableId = fixedTableId;
    this.rooms = new Map();       // tableId -> Room
    this.players = new Map();     // token -> { playerId, name, avatar }
    this.byPlayerId = new Map();  // playerId -> token
    this.sweeper = unref(setInterval(() => this.sweep(), 15_000));
  }

  connect(transport) { return new Conn(this, transport); }

  newTableId() {
    if (this.fixedTableId && !this.rooms.has(this.fixedTableId)) return this.fixedTableId;
    let id;
    do { id = randomTableId(); } while (this.rooms.has(id));
    return id;
  }

  sweep() {
    for (const [id, room] of this.rooms) {
      if (!room.conns.size && Date.now() - room.lastHumanSeen > this.opts.emptyRoomMs) {
        room.dispose();
        this.rooms.delete(id);
      }
    }
  }

  destroy() {
    clearInterval(this.sweeper);
    for (const r of this.rooms.values()) r.dispose();
    this.rooms.clear();
  }
}

class Room {
  constructor(hub, id, { blinds = '10/20', stack = 2000, bots = 0 } = {}) {
    const [sb, bb] = BLINDS[blinds] || BLINDS['10/20'];
    this.hub = hub;
    this.opts = hub.opts;
    this.id = id;
    this.stack = STACKS.includes(Number(stack)) ? Number(stack) : 2000;
    this.game = new HoldemGame({ smallBlind: sb, bigBlind: bb, maxSeats: 6 });
    this.conns = new Map();   // playerId -> Conn
    this.timers = {};
    this.turnKey = null;
    this.clock = null;
    this.botStats = {};
    this.lastHumanSeen = Date.now();
    this.game.on((ev) => this.onEngineEvent(ev));
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    const styles = Object.keys(PERSONALITIES);
    for (let i = 0; i < Math.min(4, Math.max(0, Number(bots) || 0)); i++) {
      const seat = SEAT_ORDER.slice(1).reverse().find((s) => !this.game.seats[s]);
      const botId = `bot-${id}-${i}`;
      this.game.addPlayer({ id: botId, name: names[i], chips: this.stack, seat, isBot: true,
        meta: { avatar: names[i] + randomInt(1e6), style: styles[randomInt(styles.length)] } });
      this.botStats[botId] = { hands: 0, wins: 0, biggest: 0 };
    }
  }

  dispose() { for (const t of Object.values(this.timers)) clearTimeout(t); this.timers = {}; }

  // ---------- рассылка ----------
  sendTo(pid, msg) { this.conns.get(pid)?.send(msg); }
  broadcast(build) { for (const [pid, c] of this.conns) c.send(build(pid)); }
  state(pid) { return this.game.getState(pid); }
  pushState() { this.broadcast((pid) => ({ type: 'state', state: this.state(pid) })); }

  onEngineEvent(ev) {
    if (ev.type === 'action') this.stopClock();
    if (ev.type === 'handEnd') this.recordStats(ev);
    if (ev.type === 'transfer') {
      this.sendTo(ev.to, { type: 'toast', key: 'toast.received', params: { name: this.nameOf(ev.from), amount: ev.amount } });
    }
    // Каждый получает событие вместе с состоянием «своими глазами»: чужие карты скрыты
    this.broadcast((pid) => ({ type: 'event', ev, state: this.state(pid) }));
  }

  nameOf(id) { const s = this.game.findSeat(id); return s >= 0 ? this.game.seats[s].name : ''; }

  // ---------- игроки ----------
  seatHuman(conn) {
    const g = this.game;
    const existing = g.findSeat(conn.playerId);
    if (existing >= 0) {
      const p = g.seats[existing];
      p.name = conn.name;
      p.meta.avatar = conn.avatar;
      p.meta.connected = true;
      if (p.meta.away) { p.meta.away = false; g.setSittingOut(p.id, false); }
    } else {
      let seat = SEAT_ORDER.find((s) => !g.seats[s]);
      if (seat === undefined) {
        // Нет мест — уступает бот, который сейчас не в раздаче
        const bot = g.seats.find((p) => p && p.isBot && !(g.isHandRunning() && g.hand.seats[p.seat] && !g.hand.seats[p.seat].folded));
        if (!bot) throw new PokerError('tableFull');
        seat = bot.seat;
        g.removePlayer(bot.id);
      }
      g.addPlayer({ id: conn.playerId, name: conn.name, chips: this.stack, seat,
        meta: { avatar: conn.avatar, connected: true, media: { cam: false, mic: false } } });
    }
    clearTimeout(this.timers['away:' + conn.playerId]);
    this.conns.set(conn.playerId, conn);
    conn.room = this;
    this.lastHumanSeen = Date.now();
    this.pushState();
    this.sendClock(conn.playerId);
    this.schedule();
  }

  disconnect(conn, leaving = false) {
    if (this.conns.get(conn.playerId) !== conn) return;
    this.conns.delete(conn.playerId);
    const g = this.game;
    const seat = g.findSeat(conn.playerId);
    if (seat < 0) return;
    if (leaving) {
      g.removePlayer(conn.playerId);
    } else {
      const p = g.seats[seat];
      p.meta.connected = false;
      p.meta.away = true;
      p.meta.media = { cam: false, mic: false };
      g.setSittingOut(p.id, true);
      // Его ход — не ждём 30 секунд
      if (g.isHandRunning() && g.hand.toAct === seat) this.later('turn', () => this.timeoutTurn(seat), 800);
      this.timers['away:' + p.id] = setTimeout(() => {
        if (!this.conns.has(p.id) && this.game.findSeat(p.id) >= 0) { this.game.removePlayer(p.id); this.pushState(); this.schedule(); }
      }, this.opts.awayRemoveMs);
    }
    if (!this.conns.size) this.lastHumanSeen = Date.now();
    this.pushState();
    this.schedule();
  }

  // ---------- ход игры ----------
  later(name, fn, ms) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => { delete this.timers[name]; try { fn(); } catch (e) { console.error(e); } this.schedule(); }, ms);
  }

  run(fn) { try { return fn(); } finally { this.schedule(); } }

  schedule() {
    const g = this.game;
    const { turnMs, graceMs, nextHandMs, botDelay } = this.opts;
    if (g.isHandRunning()) {
      const seat = g.hand.toAct;
      if (seat < 0) return;
      const key = `${g.handNumber}:${g.hand.log.length}:${seat}`;
      if (this.turnKey === key) return;
      this.turnKey = key;
      const p = g.seats[seat];
      this.startClock(seat);
      if (p.isBot) {
        this.later('turn', () => {
          if (!g.isHandRunning() || g.hand.toAct !== seat) return;
          const a = decide(g.getState(p.id), p.id, PERSONALITIES[p.meta.style]);
          try { g.act(p.id, a); } catch { g.act(p.id, g.timeoutAction(p.id)); }
        }, botDelay[0] + Math.random() * (botDelay[1] - botDelay[0]));
      } else if (p.meta.away) {
        this.later('turn', () => this.timeoutTurn(seat), 800);
      } else {
        this.later('turn', () => this.timeoutTurn(seat), turnMs + graceMs);
      }
      return;
    }
    this.turnKey = null;
    this.stopClock();
    if (!this.timers.next && g.canStartHand() && this.humansPlaying() > 0) {
      this.later('next', () => { if (!g.isHandRunning() && g.canStartHand()) g.startHand(); }, nextHandMs);
    }
  }

  humansPlaying() {
    return this.game.seats.filter((p) => p && !p.isBot && !p.sittingOut && p.chips > 0).length;
  }

  timeoutTurn(seat) {
    const g = this.game;
    if (!g.isHandRunning() || g.hand.toAct !== seat) return;
    const p = g.seats[seat];
    const a = g.timeoutAction(p.id);
    this.broadcast(() => ({ type: 'timeout', id: p.id, name: p.name }));
    if (!p.meta.away) this.sendTo(p.id, { type: 'toast', key: a.type === 'check' ? 'toast.timeoutCheck' : 'toast.timeoutFold' });
    g.act(p.id, a);
  }

  startClock(seat) {
    this.clock = { seat, endsAt: Date.now() + this.opts.turnMs };
    this.broadcast(() => this.clockMsg());
  }
  stopClock() {
    if (!this.clock) return;
    this.clock = null;
    this.broadcast(() => this.clockMsg());
  }
  clockMsg() {
    return this.clock
      ? { type: 'clock', seat: this.clock.seat, total: this.opts.turnMs, remaining: Math.max(0, this.clock.endsAt - Date.now()) }
      : { type: 'clock', seat: -1 };
  }
  sendClock(pid) { this.sendTo(pid, this.clockMsg()); }

  recordStats(ev) {
    const { stats, byPlayerId } = this.hub;
    const won = {};
    for (const w of ev.results.winners) {
      if (w.uncalled) continue;
      const pid = ev.participants.find((x) => x.seat === w.seat)?.id;
      if (pid) won[pid] = (won[pid] || 0) + w.amount;
    }
    for (const { id } of ev.participants) {
      const token = byPlayerId.get(id);
      const rec = token ? stats.get(token) : (this.botStats[id] ||= { hands: 0, wins: 0, biggest: 0 });
      rec.hands++;
      if (won[id]) { rec.wins++; rec.biggest = Math.max(rec.biggest, won[id]); }
      if (token) stats.touch();
    }
  }

  profile(id) {
    const s = this.game.findSeat(id);
    if (s < 0) throw new PokerError('playerNotFound');
    const p = this.game.seats[s];
    const token = this.hub.byPlayerId.get(id);
    const st = token ? this.hub.stats.get(token) : (this.botStats[id] || { hands: 0, wins: 0, biggest: 0 });
    return { id, name: p.name, isBot: p.isBot, meta: p.meta, chips: p.chips, hands: st.hands, wins: st.wins, biggest: st.biggest };
  }
}

// ---------- соединение ----------
class Conn {
  constructor(hub, transport) { this.hub = hub; this.t = transport; this.playerId = null; this.room = null; }
  send(msg) { try { this.t.send(JSON.stringify(msg)); } catch { /* соединение уже закрыто */ } }
  reply(req, msg) { this.send({ ...msg, reqId: req.reqId }); }
  fail(req, code, params) { this.send({ type: 'error', code, params, reqId: req.reqId }); }

  receive(raw) {
    if (typeof raw !== 'string' || raw.length > 64 * 1024) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { this.handle(m); } catch (e) { console.error(e); }
  }

  closed() { if (this.room) this.room.disconnect(this); }

  handle(m) {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'hello') return this.hello(m);
    if (!this.playerId) return this.fail(m, 'generic');
    const hub = this.hub;
    switch (m.type) {
      case 'create': {
        if (this.room) this.room.disconnect(this, true);
        const id = hub.newTableId();
        const room = new Room(hub, id, { blinds: m.blinds, stack: m.stack, bots: m.bots });
        hub.rooms.set(id, room);
        room.seatHuman(this);
        return this.reply(m, { type: 'joined', tableId: id, state: room.state(this.playerId) });
      }
      case 'join': {
        const room = hub.rooms.get(String(m.tableId || '').toUpperCase());
        if (!room) return this.fail(m, 'tableNotFound');
        if (this.room && this.room !== room) this.room.disconnect(this, true);
        try { room.seatHuman(this); } catch (e) { return this.fail(m, e.code || 'generic'); }
        return this.reply(m, { type: 'joined', tableId: room.id, state: room.state(this.playerId) });
      }
      case 'leave':
        if (this.room) { this.room.disconnect(this, true); this.room = null; }
        return;
      case 'act':
        if (!this.room) return;
        return this.room.run(() => {
          try { this.room.game.act(this.playerId, m.action || {}); }
          catch (e) { this.send({ type: 'error', code: e.code || 'generic', params: e.params }); }
        });
      case 'transfer':
        if (!this.room) return;
        return this.room.run(() => {
          try {
            const res = this.room.game.transfer(this.playerId, String(m.to), m.amount);
            const name = this.room.nameOf(String(m.to));
            const amount = Math.floor(Number(m.amount));
            this.send({ type: 'toast', key: res.queued ? 'toast.sentQueued' : 'toast.sent', params: { name, amount } });
          } catch (e) { this.send({ type: 'error', code: e.code || 'generic', params: e.params }); }
        });
      case 'profile':
        if (!this.room) return this.fail(m, 'playerNotFound');
        try { return this.reply(m, { type: 'profile', profile: this.room.profile(String(m.playerId)) }); }
        catch (e) { return this.fail(m, e.code || 'generic'); }
      case 'media': {
        if (!this.room) return;
        const s = this.room.game.findSeat(this.playerId);
        if (s >= 0) { this.room.game.seats[s].meta.media = { cam: !!m.cam, mic: !!m.mic }; this.room.pushState(); }
        return;
      }
      case 'rtc': {
        // Пересылаем сигнал WebRTC только игроку за тем же столом
        if (!this.room || !this.room.conns.has(String(m.to))) return;
        return this.room.sendTo(String(m.to), { type: 'rtc', from: this.playerId, data: m.data });
      }
    }
  }

  hello(m) {
    const hub = this.hub;
    const token = String(m.token || '');
    if (!/^[a-z0-9]{16,64}$/i.test(token)) return this.fail(m, 'generic');
    let rec = hub.players.get(token);
    if (!rec) {
      rec = { playerId: 'p_' + hex(12) };
      hub.players.set(token, rec);
      hub.byPlayerId.set(rec.playerId, token);
    }
    rec.name = clean(m.name) || 'Player';
    rec.avatar = clean(m.avatar, 40) || rec.playerId;
    // Тот же игрок с другой вкладки — старое соединение закрываем
    for (const room of hub.rooms.values()) {
      const old = room.conns.get(rec.playerId);
      if (old && old !== this) { room.conns.delete(rec.playerId); try { old.t.close(); } catch {} }
    }
    this.playerId = rec.playerId;
    this.name = rec.name;
    this.avatar = rec.avatar;
    const st = hub.stats.get(token);
    st.name = rec.name;
    hub.stats.touch();
    this.reply(m, { type: 'welcome', playerId: rec.playerId });
  }
}
