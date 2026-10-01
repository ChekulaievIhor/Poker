import { fullDeck, shuffle, defaultRandomInt } from './cards.js';
import { evaluate } from './evaluator.js';

/**
 * Движок No-Limit Texas Hold'em.
 * Не знает ничего про DOM и сеть: принимает действия, меняет состояние, шлёт события.
 * Этот же класс без изменений запускается на сервере (Node) — клиенты получают
 * только getState(playerId), где чужие карты скрыты.
 */

export const PHASE = {
  WAITING: 'waiting',   // раздача не идёт
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  COMPLETE: 'complete', // раздача завершена, банк выплачен
};

const STREET_ORDER = [PHASE.PREFLOP, PHASE.FLOP, PHASE.TURN, PHASE.RIVER];

/** Ошибка с машинным кодом: клиент переводит её на язык игрока (i18n: err.<code>). */
export class PokerError extends Error {
  constructor(code, params = {}) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export class HoldemGame {
  constructor({ smallBlind = 10, bigBlind = 20, maxSeats = 6, randomInt = defaultRandomInt } = {}) {
    if (bigBlind < smallBlind) throw new PokerError('badBlinds');
    this.config = { smallBlind, bigBlind, maxSeats };
    this.randomInt = randomInt;
    this.seats = new Array(maxSeats).fill(null);
    this.buttonSeat = -1;
    this.handNumber = 0;
    this.hand = null;
    this.listeners = new Set();
    this.pendingTransfers = [];
  }

  // ---------- события ----------
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data = {}) {
    const ev = { ...data, type, hand: this.handNumber };
    for (const fn of this.listeners) fn(ev);
  }

  // ---------- игроки ----------
  addPlayer({ id, name, chips, seat, isBot = false, meta = {} }) {
    if (this.findSeat(id) !== -1) throw new PokerError('alreadySeated');
    if (seat == null) seat = this.seats.findIndex((s) => s === null);
    if (seat < 0 || seat >= this.seats.length || this.seats[seat]) throw new PokerError('seatTaken');
    this.seats[seat] = { id, name, chips, seat, isBot, sittingOut: false, meta };
    this.emit('playerJoined', { seat, id, name, chips });
    return seat;
  }

  removePlayer(id) {
    const seat = this.findSeat(id);
    if (seat === -1) return;
    if (this.isHandRunning() && this.hand.seats[seat] && !this.hand.seats[seat].folded) {
      // Уходит посреди раздачи — сбрасывает карты
      if (this.hand.toAct === seat) this.act(id, { type: 'fold' });
      else this.hand.seats[seat].folded = true;
    }
    this.seats[seat] = null;
    this.pendingTransfers = this.pendingTransfers.filter((t) => t.from !== id && t.to !== id);
    this.emit('playerLeft', { seat, id });
    if (this.isHandRunning() && this.activeCount() === 1) this.finishByFold();
  }

  /** Пропускать следующие раздачи (игрок отошёл / отключился). Текущую раздачу не трогает. */
  setSittingOut(id, value) {
    const seat = this.findSeat(id);
    if (seat === -1) return;
    this.seats[seat].sittingOut = !!value;
    this.emit('sitOut', { seat, id, value: !!value });
  }

  // ---------- передача фишек ----------
  /**
   * Игрок дарит фишки другому игроку за столом.
   * Во время раздачи перевод ставится в очередь и выполняется после неё — чтобы не менять стеки посреди торгов.
   */
  transfer(fromId, toId, amount) {
    const fromSeat = this.findSeat(fromId);
    const toSeat = this.findSeat(toId);
    if (fromSeat === -1 || toSeat === -1) throw new PokerError('playerNotFound');
    if (fromSeat === toSeat) throw new PokerError('transferSelf');
    amount = Math.floor(Number(amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new PokerError('badAmount');
    const reserved = this.pendingTransfers.filter((t) => t.from === fromId).reduce((a, t) => a + t.amount, 0);
    const available = this.seats[fromSeat].chips - reserved;
    if (amount > available) throw new PokerError('notEnoughChips');
    const t = { from: fromId, to: toId, amount };
    if (this.isHandRunning()) {
      this.pendingTransfers.push(t);
      this.emit('transferQueued', { ...t, fromSeat, toSeat });
      return { queued: true };
    }
    this.applyTransfer(t);
    return { queued: false };
  }

  applyTransfer(t) {
    const fromSeat = this.findSeat(t.from);
    const toSeat = this.findSeat(t.to);
    if (fromSeat === -1 || toSeat === -1) return;
    const amount = Math.min(t.amount, this.seats[fromSeat].chips); // за раздачу стек мог уменьшиться
    if (amount <= 0) return;
    this.seats[fromSeat].chips -= amount;
    this.seats[toSeat].chips += amount;
    this.emit('transfer', { from: t.from, to: t.to, fromSeat, toSeat, amount });
  }

  flushTransfers() {
    const list = this.pendingTransfers;
    this.pendingTransfers = [];
    for (const t of list) this.applyTransfer(t);
  }

  findSeat(id) { return this.seats.findIndex((p) => p && p.id === id); }
  player(seat) { return this.seats[seat]; }

  isHandRunning() {
    return !!this.hand && this.hand.phase !== PHASE.COMPLETE;
  }

  // Места по часовой стрелке, начиная со следующего после from
  seatsFrom(from, predicate) {
    const n = this.seats.length;
    const res = [];
    for (let i = 1; i <= n; i++) {
      const s = (from + i + n) % n;
      if (predicate(s)) res.push(s);
    }
    return res;
  }

  // ---------- начало раздачи ----------
  canStartHand() {
    return this.seats.filter((p) => p && p.chips > 0 && !p.sittingOut).length >= 2;
  }

  startHand() {
    if (this.isHandRunning()) throw new PokerError('handRunning');
    if (!this.canStartHand()) throw new PokerError('needTwoPlayers');

    const eligible = (s) => { const p = this.seats[s]; return p && p.chips > 0 && !p.sittingOut; };
    this.handNumber++;

    // Кнопка — на следующего живого игрока
    this.buttonSeat = this.seatsFrom(this.buttonSeat < 0 ? -1 : this.buttonSeat, eligible)[0];
    const order = this.seatsFrom(this.buttonSeat, eligible); // после кнопки, кнопка — последняя
    const headsUp = order.length === 2;
    const sbSeat = headsUp ? this.buttonSeat : order[0];
    const bbSeat = headsUp ? order[0] : order[1];

    const hs = {};
    for (const s of order) {
      hs[s] = { hole: [], bet: 0, committed: 0, folded: false, allIn: false, hasActed: false, raiseSeen: 0, lastAction: null };
    }

    this.hand = {
      id: this.handNumber,
      phase: PHASE.PREFLOP,
      deck: shuffle(fullDeck(), this.randomInt),
      board: [],
      seats: hs,
      ids: Object.fromEntries(order.map((s) => [s, this.seats[s].id])),
      shown: null,
      buttonSeat: this.buttonSeat,
      sbSeat, bbSeat,
      currentBet: 0,
      minRaise: this.config.bigBlind,
      raiseCounter: 0,
      toAct: -1,
      results: null,
      log: [],
    };

    this.emit('handStart', { buttonSeat: this.buttonSeat, sbSeat, bbSeat });

    this.postBlind(sbSeat, this.config.smallBlind, 'sb');
    this.postBlind(bbSeat, this.config.bigBlind, 'bb');
    this.hand.currentBet = this.config.bigBlind;

    // Раздача по 2 карты, начиная с SB
    const dealOrder = this.seatsFrom(this.buttonSeat, (s) => !!hs[s]);
    for (let r = 0; r < 2; r++) for (const s of dealOrder) hs[s].hole.push(this.hand.deck.pop());
    this.emit('dealHole', {});

    // Первым ходит игрок после BB
    this.hand.toAct = this.nextToAct(bbSeat);
    this.afterAction();
  }

  postBlind(seat, amount, kind) {
    const p = this.seats[seat];
    const h = this.hand.seats[seat];
    const amt = Math.min(amount, p.chips);
    p.chips -= amt;
    h.bet += amt;
    h.committed += amt;
    if (p.chips === 0) h.allIn = true;
    h.lastAction = kind;
    this.emit('blind', { seat, amount: amt, kind });
  }

  // ---------- вспомогательные ----------
  inHand(s) { const h = this.hand.seats[s]; return !!h && !h.folded; }
  canAct(s) { const h = this.hand.seats[s]; return !!h && !h.folded && !h.allIn && !!this.seats[s]; }

  needsAction(s) {
    const h = this.hand.seats[s];
    if (!this.canAct(s)) return false;
    if (!h.hasActed) return true;
    return h.bet < this.hand.currentBet;
  }

  nextToAct(fromSeat) {
    const list = this.seatsFrom(fromSeat, (s) => this.needsAction(s));
    return list.length ? list[0] : -1;
  }

  activeCount() { return Object.keys(this.hand.seats).filter((s) => this.inHand(+s)).length; }
  canActCount() { return Object.keys(this.hand.seats).filter((s) => this.canAct(+s)).length; }

  // ---------- легальные действия ----------
  getLegalActions(playerId) {
    const seat = this.findSeat(playerId);
    if (!this.isHandRunning() || seat !== this.hand.toAct) return null;
    const p = this.seats[seat];
    const h = this.hand.seats[seat];
    const toCall = Math.max(0, this.hand.currentBet - h.bet);
    const callAmount = Math.min(toCall, p.chips);
    const maxTo = h.bet + p.chips;

    const othersCanRespond = Object.keys(this.hand.seats)
      .some((s) => +s !== seat && this.canAct(+s));
    const hasRaiseRights = !h.hasActed || h.raiseSeen < this.hand.raiseCounter;
    const canRaise = hasRaiseRights && othersCanRespond && p.chips > toCall;

    let minRaiseTo = this.hand.currentBet + this.hand.minRaise;
    if (this.hand.currentBet === 0) minRaiseTo = this.config.bigBlind;
    minRaiseTo = Math.min(minRaiseTo, maxTo); // если фишек меньше — только олл-ин

    return {
      seat,
      canFold: true,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount,
      canRaise,
      isBet: this.hand.currentBet === 0, // «ставка» вместо «рейз»
      minRaiseTo,
      maxRaiseTo: maxTo,
      currentBet: this.hand.currentBet,
      myBet: h.bet,
      pot: this.potTotal(),
    };
  }

  /** Действие по истечении времени на ход: чек, если можно, иначе фолд. Сервер вызовет то же самое. */
  timeoutAction(playerId) {
    const legal = this.getLegalActions(playerId);
    if (!legal) return null;
    return { type: legal.canCheck ? 'check' : 'fold' };
  }

  potTotal() {
    if (!this.hand) return 0;
    return Object.values(this.hand.seats).reduce((a, h) => a + h.committed, 0);
  }

  // ---------- действие игрока ----------
  /**
   * action: { type: 'fold' | 'check' | 'call' | 'raise' | 'allin', amount?: число «до скольки» для raise }
   */
  act(playerId, action) {
    const legal = this.getLegalActions(playerId);
    if (!legal) throw new PokerError('notYourTurn');
    const seat = legal.seat;
    const p = this.seats[seat];
    const h = this.hand.seats[seat];
    let { type } = action;

    if (type === 'allin') {
      type = (legal.canRaise && legal.maxRaiseTo > legal.currentBet) ? 'raise' : 'call';
      if (type === 'call' && !legal.canCall) type = 'check';
      action = { type, amount: legal.maxRaiseTo };
    }

    let logged;
    switch (type) {
      case 'fold':
        h.folded = true;
        logged = { type: 'fold' };
        break;
      case 'check':
        if (!legal.canCheck) throw new PokerError('cantCheck');
        logged = { type: 'check' };
        break;
      case 'call': {
        if (!legal.canCall) throw new PokerError('nothingToCall');
        this.moveChips(seat, legal.callAmount);
        logged = { type: 'call', amount: legal.callAmount, to: h.bet };
        break;
      }
      case 'raise': {
        if (!legal.canRaise) throw new PokerError('raiseUnavailable');
        const to = Math.floor(Number(action.amount));
        if (!Number.isFinite(to)) throw new PokerError('badAmount');
        if (to > legal.maxRaiseTo) throw new PokerError('notEnoughChips');
        const isAllIn = to === legal.maxRaiseTo;
        if (to < legal.minRaiseTo && !isAllIn) throw new PokerError('minRaise', { min: legal.minRaiseTo });
        if (to <= this.hand.currentBet) throw new PokerError('raiseTooSmall');

        const raiseSize = to - this.hand.currentBet;
        const fullRaise = raiseSize >= this.hand.minRaise || this.hand.currentBet === 0 && to >= this.config.bigBlind;
        this.moveChips(seat, to - h.bet);
        if (fullRaise) {
          this.hand.minRaise = Math.max(raiseSize, this.config.bigBlind);
          this.hand.raiseCounter++;
        }
        // Неполный олл-ин-рейз не открывает торги заново для уже ходивших
        this.hand.currentBet = to;
        logged = { type: legal.isBet ? 'bet' : 'raise', to, amount: raiseSize, full: fullRaise };
        break;
      }
      default:
        throw new PokerError('unknownAction');
    }

    h.hasActed = true;
    h.raiseSeen = this.hand.raiseCounter;
    if (p.chips === 0 && !h.folded) { h.allIn = true; logged.allIn = true; }
    h.lastAction = logged.allIn ? 'allin' : logged.type;

    this.hand.log.push({ seat, phase: this.hand.phase, ...logged });
    this.emit('action', { seat, id: p.id, name: p.name, phase: this.hand.phase, ...logged, action: logged.type });

    this.hand.toAct = this.nextToAct(seat);
    this.afterAction();
  }

  moveChips(seat, amount) {
    const p = this.seats[seat];
    const h = this.hand.seats[seat];
    const amt = Math.min(amount, p.chips);
    p.chips -= amt;
    h.bet += amt;
    h.committed += amt;
  }

  // ---------- переход по улицам ----------
  afterAction() {
    const hand = this.hand;
    if (this.activeCount() === 1) return this.finishByFold();

    if (hand.toAct !== -1) {
      // Особый случай: остался один, кто может ходить, и ему нечего уравнивать
      const s = hand.toAct;
      const h = hand.seats[s];
      if (this.canActCount() === 1 && h.bet >= hand.currentBet) {
        hand.toAct = -1;
      } else {
        this.emit('turn', { seat: s });
        return;
      }
    }

    // Круг торгов завершён
    this.collectBets();
    if (hand.phase === PHASE.RIVER) return this.showdown();

    // Если торговаться больше некому — докладываем все карты
    const runout = this.canActCount() <= 1;
    this.nextStreet();
    if (runout) {
      while (hand.phase !== PHASE.RIVER) this.nextStreet();
      return this.showdown();
    }
    hand.toAct = this.nextToAct(hand.buttonSeat);
    if (hand.toAct === -1) return this.afterAction();
    this.emit('turn', { seat: hand.toAct });
  }

  collectBets() {
    for (const h of Object.values(this.hand.seats)) {
      h.bet = 0;
      h.hasActed = false;
      h.raiseSeen = 0;
      if (!h.folded && !h.allIn) h.lastAction = null;
    }
    this.hand.currentBet = 0;
    this.hand.minRaise = this.config.bigBlind;
    this.hand.raiseCounter = 0;
    this.emit('betsCollected', { pot: this.potTotal() });
  }

  nextStreet() {
    const hand = this.hand;
    const idx = STREET_ORDER.indexOf(hand.phase);
    hand.phase = STREET_ORDER[idx + 1];
    hand.deck.pop(); // burn
    const n = hand.phase === PHASE.FLOP ? 3 : 1;
    const cards = [];
    for (let i = 0; i < n; i++) cards.push(hand.deck.pop());
    hand.board.push(...cards);
    this.emit('street', { phase: hand.phase, cards, board: hand.board.slice() });
  }

  // ---------- банки ----------
  computePots() {
    const remaining = {};
    for (const [s, h] of Object.entries(this.hand.seats)) remaining[s] = h.committed;
    const pots = [];
    const total = () => Object.values(remaining).reduce((a, b) => a + b, 0);
    while (total() > 0) {
      const live = Object.keys(remaining).filter((s) => remaining[s] > 0 && this.inHand(+s)).map(Number);
      if (!live.length) { // остались только фишки сбросивших — в последний банк
        if (pots.length) pots[pots.length - 1].amount += total();
        break;
      }
      const level = Math.min(...live.map((s) => remaining[s]));
      let amount = 0;
      for (const s of Object.keys(remaining)) {
        const take = Math.min(remaining[s], level);
        remaining[s] -= take;
        amount += take;
      }
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.join() === live.join()) prev.amount += amount;
      else pots.push({ amount, eligible: live });
    }
    return pots;
  }

  finishByFold() {
    const hand = this.hand;
    for (const h of Object.values(hand.seats)) h.bet = 0;
    const winner = Object.keys(hand.seats).map(Number).find((s) => this.inHand(s));
    const amount = this.potTotal();
    this.seats[winner] && (this.seats[winner].chips += amount);
    hand.results = { byFold: true, winners: [{ seat: winner, amount, potIndex: 0 }], pots: [{ amount, eligible: [winner] }], hands: {} };
    hand.phase = PHASE.COMPLETE;
    hand.toAct = -1;
    this.emit('win', { ...hand.results });
    this.endHand();
  }

  showdown() {
    const hand = this.hand;
    hand.phase = PHASE.SHOWDOWN;
    hand.toAct = -1;
    const live = Object.keys(hand.seats).map(Number).filter((s) => this.inHand(s));
    const hands = {};
    hand.shown = hands;
    for (const s of live) {
      const ev = evaluate([...hand.seats[s].hole, ...hand.board]);
      hands[s] = { score: ev.score, name: ev.name, key: ev.key, ranks: ev.ranks, category: ev.category, best: ev.best, hole: hand.seats[s].hole };
    }
    this.emit('showdown', { hands });

    const pots = this.computePots();
    const winners = [];
    pots.forEach((pot, potIndex) => {
      const best = Math.max(...pot.eligible.map((s) => hands[s].score));
      const ws = pot.eligible.filter((s) => hands[s].score === best);
      // Нечётная фишка — первому победителю слева от кнопки
      const ordered = this.seatsFrom(hand.buttonSeat, (s) => ws.includes(s));
      const share = Math.floor(pot.amount / ws.length);
      let odd = pot.amount - share * ws.length;
      for (const s of ordered) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        if (this.seats[s]) this.seats[s].chips += amt;
        winners.push({ seat: s, amount: amt, potIndex, uncalled: pot.eligible.length === 1 });
      }
    });

    hand.results = { byFold: false, winners, pots, hands };
    hand.phase = PHASE.COMPLETE;
    this.emit('win', { ...hand.results });
    this.endHand();
  }

  endHand() {
    const hand = this.hand;
    // Кто участвовал — для статистики (сыграно / выиграно)
    const participants = Object.keys(hand.seats).map(Number)
      .map((s) => ({ seat: s, id: hand.ids[s] }));
    this.emit('handEnd', { results: hand.results, participants });
    this.flushTransfers();
  }

  // ---------- представление для клиента ----------
  /** Состояние стола глазами viewerId: чужие карты скрыты, пока их не вскрыли на шоудауне. */
  getState(viewerId = null) {
    const hand = this.hand;
    const shown = (hand && hand.shown) || {};
    const reveal = hand && (hand.phase === PHASE.SHOWDOWN || hand.phase === PHASE.COMPLETE);
    return {
      config: { ...this.config },
      handNumber: this.handNumber,
      phase: hand ? hand.phase : PHASE.WAITING,
      board: hand ? hand.board.slice() : [],
      pot: this.potTotal(),
      currentBet: hand ? hand.currentBet : 0,
      buttonSeat: this.buttonSeat,
      sbSeat: hand ? hand.sbSeat : -1,
      bbSeat: hand ? hand.bbSeat : -1,
      toAct: hand ? hand.toAct : -1,
      seats: this.seats.map((p, s) => {
        if (!p) return null;
        const h = hand && hand.seats[s];
        let hole = null;
        if (h && h.hole.length) {
          const mine = p.id === viewerId;
          const revealed = reveal && !h.folded && shown && shown[s];
          hole = mine || revealed ? h.hole.slice() : h.hole.map(() => null);
        }
        return {
          seat: s, id: p.id, name: p.name, chips: p.chips, isBot: p.isBot, sittingOut: p.sittingOut, meta: p.meta,
          inHand: !!h, folded: h ? h.folded : false, allIn: h ? h.allIn : false,
          bet: h ? h.bet : 0, committed: h ? h.committed : 0,
          lastAction: h ? h.lastAction : null, hole,
        };
      }),
      results: hand && hand.phase === PHASE.COMPLETE ? hand.results : null,
      legal: viewerId != null ? this.getLegalActions(viewerId) : null,
    };
  }
}
