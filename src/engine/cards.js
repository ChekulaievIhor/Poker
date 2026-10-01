// Карты: строка из 2 символов — ранг + масть, например "As", "Td", "7h".
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // spades, hearts, diamonds, clubs

export function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2; // 2..14
}

export function suitOf(card) {
  return card[1];
}

export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

// Криптостойкий ГСЧ по умолчанию (браузер и Node 19+). Можно подменить для тестов.
export function defaultRandomInt(maxExclusive) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    // Отбрасывание для равномерности
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    do { c.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

// Fisher–Yates
export function shuffle(arr, randomInt = defaultRandomInt) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Детерминированный ГСЧ для тестов / воспроизведения раздач
export function seededRandomInt(seed) {
  let s = seed >>> 0;
  return (max) => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    t = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(t * max);
  };
}
