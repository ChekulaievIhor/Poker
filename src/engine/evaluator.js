import { rankValue, suitOf } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
  FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAMES_RU = [
  'Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит',
  'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш',
];

const RANK_NAMES_RU = {
  2: 'двойки', 3: 'тройки', 4: 'четвёрки', 5: 'пятёрки', 6: 'шестёрки', 7: 'семёрки',
  8: 'восьмёрки', 9: 'девятки', 10: 'десятки', 11: 'вальты', 12: 'дамы', 13: 'короли', 14: 'тузы',
};
const RANK_SHORT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export const short = (v) => RANK_SHORT[v] || String(v);

function scoreOf(category, kickers) {
  // Упаковка в одно число: категория + до 5 кикеров по основанию 15
  let s = category;
  for (let i = 0; i < 5; i++) s = s * 15 + (kickers[i] || 0);
  return s;
}

// Находит старшую карту стрита в наборе значений (учитывает A-2-3-4-5)
function straightTop(valuesSet) {
  for (let top = 14; top >= 5; top--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      let v = top - k;
      if (v === 1) v = 14;
      if (!valuesSet.has(v)) { ok = false; break; }
    }
    if (ok) return top;
  }
  return 0;
}

function pickStraightCards(cards, top) {
  const res = [];
  for (let k = 0; k < 5; k++) {
    let v = top - k;
    if (v === 1) v = 14;
    res.push(cards.find((c) => rankValue(c) === v));
  }
  return res;
}

/**
 * Оценивает лучшую 5-карточную комбинацию из 5–7 карт.
 * Возвращает { score, category, name, best } — больший score сильнее.
 */
export function evaluate(cards) {
  const sorted = cards.slice().sort((a, b) => rankValue(b) - rankValue(a));
  const bySuit = {};
  const byRank = {};
  for (const c of sorted) {
    (bySuit[suitOf(c)] ||= []).push(c);
    (byRank[rankValue(c)] ||= []).push(c);
  }

  // Флеш / стрит-флеш
  const flushSuit = Object.keys(bySuit).find((s) => bySuit[s].length >= 5);
  if (flushSuit) {
    const fc = bySuit[flushSuit];
    const top = straightTop(new Set(fc.map(rankValue)));
    if (top) {
      const best = pickStraightCards(fc, top);
      return result(CATEGORY.STRAIGHT_FLUSH, [top], best,
        top === 14 ? 'Роял-флеш' : `Стрит-флеш до ${short(top)}`, top === 14 ? 'royal' : 'straightFlush', [top]);
    }
  }

  // Группы по количеству: [значение, карты], сортировка по (кол-во, значение)
  const groups = Object.entries(byRank)
    .map(([v, cs]) => [Number(v), cs])
    .sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);

  const kickersExcept = (exclude, n) =>
    sorted.filter((c) => !exclude.includes(c)).slice(0, n);

  // Каре
  if (groups[0][1].length === 4) {
    const quad = groups[0][1];
    const k = kickersExcept(quad, 1);
    return result(CATEGORY.QUADS, [groups[0][0], ...k.map(rankValue)], [...quad, ...k],
      `Каре: ${RANK_NAMES_RU[groups[0][0]]}`, 'quads', [groups[0][0]]);
  }

  // Фулл-хаус
  if (groups[0][1].length === 3) {
    const pairGroup = groups.slice(1).find((g) => g[1].length >= 2);
    if (pairGroup) {
      const best = [...groups[0][1], ...pairGroup[1].slice(0, 2)];
      return result(CATEGORY.FULL_HOUSE, [groups[0][0], pairGroup[0]], best,
        `Фулл-хаус: ${RANK_NAMES_RU[groups[0][0]]} и ${RANK_NAMES_RU[pairGroup[0]]}`, 'fullHouse', [groups[0][0], pairGroup[0]]);
    }
  }

  if (flushSuit) {
    const best = bySuit[flushSuit].slice(0, 5);
    return result(CATEGORY.FLUSH, best.map(rankValue), best, `Флеш до ${short(rankValue(best[0]))}`, 'flush', [rankValue(best[0])]);
  }

  const top = straightTop(new Set(sorted.map(rankValue)));
  if (top) {
    return result(CATEGORY.STRAIGHT, [top], pickStraightCards(sorted, top), `Стрит до ${short(top)}`, 'straight', [top]);
  }

  if (groups[0][1].length === 3) {
    const trips = groups[0][1];
    const k = kickersExcept(trips, 2);
    return result(CATEGORY.TRIPS, [groups[0][0], ...k.map(rankValue)], [...trips, ...k],
      `Сет: ${RANK_NAMES_RU[groups[0][0]]}`, 'trips', [groups[0][0]]);
  }

  if (groups[0][1].length === 2 && groups[1] && groups[1][1].length === 2) {
    const p1 = groups[0][1], p2 = groups[1][1];
    const k = kickersExcept([...p1, ...p2], 1);
    return result(CATEGORY.TWO_PAIR, [groups[0][0], groups[1][0], ...k.map(rankValue)],
      [...p1, ...p2, ...k], `Две пары: ${RANK_NAMES_RU[groups[0][0]]} и ${RANK_NAMES_RU[groups[1][0]]}`, 'twoPair', [groups[0][0], groups[1][0]]);
  }

  if (groups[0][1].length === 2) {
    const p = groups[0][1];
    const k = kickersExcept(p, 3);
    return result(CATEGORY.PAIR, [groups[0][0], ...k.map(rankValue)], [...p, ...k],
      `Пара: ${RANK_NAMES_RU[groups[0][0]]}`, 'pair', [groups[0][0]]);
  }

  const best = sorted.slice(0, 5);
  return result(CATEGORY.HIGH_CARD, best.map(rankValue), best, `Старшая карта ${short(rankValue(best[0]))}`, 'highCard', [rankValue(best[0])]);
}

// key + ranks — для перевода названия комбинации на любой язык (i18n: hand.<key>)
function result(category, kickers, best, name, key, ranks) {
  return { score: scoreOf(category, kickers), category, name, best, key, ranks: ranks.map(short) };
}

// Быстрая оценка только score (для Monte Carlo ботов) — та же функция, но без лишних полей
export function scoreHand(cards) {
  return evaluate(cards).score;
}
