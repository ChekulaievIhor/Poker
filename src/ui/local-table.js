// Стол с ботами прямо в браузере. Тот же интерфейс, что у NetTable, — UI не знает, где идёт игра.
import { HoldemGame } from '../engine/game.js';
import { decide, PERSONALITIES } from '../bots/bot.js';
import { Emitter } from './emitter.js';

export const BOT_NAMES = ['Marco', 'Irina', 'Dan', 'Oksana', 'Leo', 'Vera', 'Taras', 'Niko', 'Lena', 'Omar', 'Sofia', 'Jan'];
export const BOT_LAYOUT = { 1: [3], 2: [2, 4], 3: [2, 3, 4], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5] };
const SPEED = { slow: 1.5, normal: 1, fast: 0.45 };

function loadHeroStats() {
  try { return { hands: 0, wins: 0, biggest: 0, ...JSON.parse(localStorage.getItem('holdem.stats') || '{}') }; }
  catch { return { hands: 0, wins: 0, biggest: 0 }; }
}
function saveHeroStats(s) { try { localStorage.setItem('holdem.stats', JSON.stringify(s)); } catch {} }

export class LocalTable extends Emitter {
  constructor(settings, { turnSeconds = 30 } = {}) {
    super();
    this.mode = 'local';
    this.myId = 'hero';
    this.settings = settings;
    this.turnMs = turnSeconds * 1000;
    this.clock = null;
    this.timers = new Set();
    this.dead = false;
    this.stats = { hero: loadHeroStats() };
  }

  speed() { return SPEED[this.settings.speed] || 1; }
  later(fn, ms) {
    const id = setTimeout(() => { this.timers.delete(id); if (!this.dead) fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  start() {
    const s = this.settings;
    const g = this.game = new HoldemGame({ smallBlind: s.sb, bigBlind: s.bb, maxSeats: 6 });
    g.addPlayer({ id: this.myId, name: s.name, chips: s.stack, seat: 0, meta: { avatar: s.avatar } });
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    const styles = Object.keys(PERSONALITIES);
    BOT_LAYOUT[s.bots].forEach((seat, i) => {
      const style = styles[Math.floor(Math.random() * styles.length)];
      g.addPlayer({ id: 'bot' + seat, name: names[i], chips: s.stack, seat, isBot: true,
        meta: { avatar: names[i] + Math.floor(Math.random() * 1e6), style } });
      this.stats['bot' + seat] = { hands: 0, wins: 0, biggest: 0 };
    });
    g.on((ev) => {
      if (ev.type === 'action') this.stopClock();
      if (ev.type === 'handEnd') this.recordStats(ev);
      this.emit('event', ev, this.snap());
    });
    this.emit('state', this.snap());
    this.game.startHand();
  }

  snap() {
    const st = this.game.getState(this.myId);
    st.myId = this.myId;
    st.mode = this.mode;
    st.clock = this.clockInfo();
    return st;
  }

  // UI доиграл анимации — можно звать бота или следующую раздачу
  idle() {
    if (this.dead) return;
    const g = this.game;
    if (g.isHandRunning()) {
      const seat = g.hand.toAct;
      const p = g.seats[seat];
      if (!p) return;
      const key = `${g.handNumber}:${g.hand.log.length}:${seat}`;
      if (!this.clock || this.clock.key !== key) this.startClock(seat, key);
      if (p.isBot && !this.botPending) {
        this.botPending = true;
        this.later(() => {
          this.botPending = false;
          if (!g.isHandRunning() || g.hand.toAct !== seat) return;
          const view = g.getState(p.id);
          const a = decide(view, p.id, PERSONALITIES[p.meta.style]);
          try { g.act(p.id, a); } catch { g.act(p.id, g.timeoutAction(p.id)); }
        }, (500 + Math.random() * 900) * this.speed());
      }
      return;
    }
    this.stopClock();
    const hero = g.seats[0];
    const alive = g.seats.filter((x) => x && x.chips > 0);
    if (!hero || hero.chips === 0) return this.emit('end', false, g.handNumber);
    if (alive.length === 1) return this.emit('end', true, g.handNumber);
    if (!this.nextPending) {
      this.nextPending = true;
      this.emit('waiting', 'nextHand');
      this.later(() => { this.nextPending = false; if (!g.isHandRunning() && g.canStartHand()) g.startHand(); }, 2400 * this.speed());
    }
  }

  act(action) { this.game.act(this.myId, action); }
  transfer(toId, amount) { return this.game.transfer(this.myId, toId, amount); }

  async profile(id) {
    const g = this.game;
    const seat = g.findSeat(id);
    const p = g.seats[seat];
    const st = this.stats[id] || { hands: 0, wins: 0, biggest: 0 };
    return { id, name: p.name, isBot: p.isBot, meta: p.meta, chips: p.chips, ...st };
  }

  recordStats(ev) {
    const won = {};
    for (const w of ev.results.winners) {
      if (w.uncalled) continue;
      const pid = ev.participants.find((x) => x.seat === w.seat)?.id;
      if (pid) won[pid] = (won[pid] || 0) + w.amount;
    }
    for (const { id } of ev.participants) {
      const s = (this.stats[id] ||= { hands: 0, wins: 0, biggest: 0 });
      s.hands++;
      if (won[id]) { s.wins++; s.biggest = Math.max(s.biggest, won[id]); }
    }
    saveHeroStats(this.stats.hero);
  }

  // ---------- таймер хода ----------
  startClock(seat, key) {
    this.stopClock();
    this.clock = { seat, key, total: this.turnMs, remaining: this.turnMs, endsAt: performance.now() + this.turnMs, paused: false };
    this.clock.timer = this.later(() => this.onTimeout(), this.turnMs);
    this.emit('clock', this.clockInfo());
  }
  clockInfo() {
    const c = this.clock;
    if (!c) return null;
    return { seat: c.seat, total: c.total, paused: c.paused,
      remaining: c.paused ? c.remaining : Math.max(0, c.endsAt - performance.now()) };
  }
  stopClock() {
    if (this.clock) { clearTimeout(this.clock.timer); this.timers.delete(this.clock.timer); }
    this.clock = null;
    this.emit('clock', null);
  }
  pauseClock() {
    const c = this.clock;
    if (!c || c.paused) return;
    c.remaining = Math.max(0, c.endsAt - performance.now());
    c.paused = true;
    clearTimeout(c.timer);
    this.emit('clock', this.clockInfo());
  }
  resumeClock() {
    const c = this.clock;
    if (!c || !c.paused) return;
    c.paused = false;
    c.endsAt = performance.now() + c.remaining;
    c.timer = this.later(() => this.onTimeout(), c.remaining);
    this.emit('clock', this.clockInfo());
  }
  onTimeout() {
    const g = this.game;
    if (!this.clock || !g.isHandRunning() || g.hand.toAct !== this.clock.seat) return;
    const p = g.seats[this.clock.seat];
    const a = g.timeoutAction(p.id);
    this.emit('timeout', p.id, p.name);
    if (p.id === this.myId) this.emit('toast', a.type === 'check' ? 'toast.timeoutCheck' : 'toast.timeoutFold');
    this.stopClock();
    g.act(p.id, a);
  }

  destroy() {
    this.dead = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }
}
