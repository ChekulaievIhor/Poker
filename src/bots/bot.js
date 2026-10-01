import { fullDeck } from '../engine/cards.js';
import { scoreHand } from '../engine/evaluator.js';

/**
 * Бот видит ровно то же, что и живой игрок: getState(botId). Никакого подглядывания.
 * Решение: оценка эквити методом Монте-Карло + шансы банка + «характер».
 */

export const PERSONALITIES = {
  rock:   { label: 'Тайтовый',   tight: 0.10, aggr: 0.25, bluff: 0.03 },
  tag:    { label: 'Регуляр',    tight: 0.05, aggr: 0.55, bluff: 0.08 },
  lag:    { label: 'Агрессор',   tight: -0.03, aggr: 0.80, bluff: 0.18 },
  fish:   { label: 'Любитель',   tight: -0.08, aggr: 0.20, bluff: 0.05 },
};

export function estimateEquity(hole, board, opponents, iterations = 350, rnd = Math.random) {
  const known = new Set([...hole, ...board]);
  const deck = fullDeck().filter((c) => !known.has(c));
  let wins = 0;
  for (let it = 0; it < iterations; it++) {
    // частичная перетасовка: берём нужное количество карт
    const need = opponents * 2 + (5 - board.length);
    const d = deck.slice();
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rnd() * (d.length - i));
      [d[i], d[j]] = [d[j], d[i]];
    }
    let k = 0;
    const fullBoard = board.slice();
    while (fullBoard.length < 5) fullBoard.push(d[k++]);
    const mine = scoreHand([...hole, ...fullBoard]);
    let best = 0, ties = 0, lost = false;
    for (let o = 0; o < opponents; o++) {
      const s = scoreHand([d[k++], d[k++], ...fullBoard]);
      if (s > mine) { lost = true; break; }
      if (s === mine) ties++;
      if (s > best) best = s;
    }
    if (!lost) wins += ties ? 1 / (ties + 1) : 1;
  }
  return wins / iterations;
}

export function decide(state, botId, personality = PERSONALITIES.tag, rnd = Math.random) {
  const legal = state.legal;
  if (!legal) return null;
  const me = state.seats.find((s) => s && s.id === botId);
  const opponents = state.seats.filter((s) => s && s.inHand && !s.folded && s.id !== botId).length;
  const bb = state.config.bigBlind;

  const eq = estimateEquity(me.hole, state.board, Math.max(1, opponents), state.board.length ? 300 : 220, rnd);
  const fair = 1 / (opponents + 1);
  const strength = eq / fair; // >1 — лучше среднего за этим столом
  const noise = (rnd() - 0.5) * 0.25;
  const s = strength + noise - personality.tight * 3;

  const pot = legal.pot;
  const toCall = legal.callAmount;
  const potOdds = toCall / (pot + toCall || 1);

  const raiseTo = (fraction) => {
    const base = legal.isBet ? 0 : legal.currentBet;
    let size = legal.isBet
      ? Math.round(pot * fraction)
      : legal.currentBet + Math.round((pot + toCall) * fraction);
    size = Math.max(size, legal.minRaiseTo, base + bb);
    size = Math.round(size / bb * 2) * bb / 2 || legal.minRaiseTo; // кратно ½ BB
    size = Math.max(size, legal.minRaiseTo);
    if (size >= legal.maxRaiseTo * 0.85) size = legal.maxRaiseTo; // почти всё — значит олл-ин
    return Math.min(size, legal.maxRaiseTo);
  };

  const aggressive = rnd() < personality.aggr;

  // Монстр — давим
  if (s > 2.1 && legal.canRaise && (aggressive || rnd() < 0.5)) {
    return { type: 'raise', amount: raiseTo(0.6 + rnd() * 0.5) };
  }
  // Хорошая рука
  if (s > 1.45) {
    if (legal.canRaise && aggressive && (toCall < pot * 0.6)) {
      return { type: 'raise', amount: raiseTo(0.5 + rnd() * 0.3) };
    }
    if (legal.canCheck) return { type: 'check' };
    if (eq > potOdds * 0.9) return { type: 'call' };
  }
  // Блеф
  if (legal.canRaise && rnd() < personality.bluff && toCall <= bb * 3) {
    return { type: 'raise', amount: raiseTo(0.45 + rnd() * 0.3) };
  }
  if (legal.canCheck) return { type: 'check' };
  // Хватает шансов банка — колл
  if (eq > potOdds + personality.tight) return { type: 'call' };
  // Совсем дёшево — колл
  if (toCall <= bb && s > 0.7) return { type: 'call' };
  return { type: 'fold' };
}
