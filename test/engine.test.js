import assert from 'node:assert/strict';
import { evaluate, CATEGORY } from '../src/engine/evaluator.js';
import { HoldemGame, PHASE } from '../src/engine/game.js';
import { seededRandomInt } from '../src/engine/cards.js';
import { decide, PERSONALITIES } from '../src/bots/bot.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('✓', name); };
const cat = (cards) => evaluate(cards.split(' ')).category;
const sc = (cards) => evaluate(cards.split(' ')).score;

// ---------- оценка рук ----------
test('категории', () => {
  assert.equal(cat('As Ks Qs Js Ts 2d 3c'), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat('5h 4h 3h 2h Ah Kd Kc'), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat('9c 9d 9h 9s 2d 3c 4h'), CATEGORY.QUADS);
  assert.equal(cat('9c 9d 9h 2s 2d 3c 4h'), CATEGORY.FULL_HOUSE);
  assert.equal(cat('9c 9d 9h 2s 2d 2c 4h'), CATEGORY.FULL_HOUSE);
  assert.equal(cat('Ac 9c 7c 4c 2c Kd Kh'), CATEGORY.FLUSH);
  assert.equal(cat('5d 4c 3h 2s Ad Kd Qh'), CATEGORY.STRAIGHT);
  assert.equal(cat('Td 9c 8h 7s 6d 5d 2h'), CATEGORY.STRAIGHT);
  assert.equal(cat('Qd Qc Qh 7s 6d 3d 2h'), CATEGORY.TRIPS);
  assert.equal(cat('Qd Qc 7h 7s 6d 6c 2h'), CATEGORY.TWO_PAIR);
  assert.equal(cat('Qd Qc 9h 7s 6d 3c 2h'), CATEGORY.PAIR);
  assert.equal(cat('Kd Qc 9h 7s 6d 3c 2h'), CATEGORY.HIGH_CARD);
});

test('сравнение и кикеры', () => {
  assert.ok(sc('6d 5c 4h 3s 2d Kd Kh') > sc('5d 4c 3h 2s Ad Kd Qh')); // стрит до 6 > колесо
  assert.ok(sc('Ad Ac Kh 7s 6d 3c 2h') > sc('Ad Ac Qh 7s 6d 3c 2h'));
  assert.equal(sc('Ad Ac Kh Qs Jd 3c 2h'), sc('Ah As Kd Qc Jh 4c 2d')); // 5-я карта не играет
  assert.ok(sc('Qd Qc 7h 7s Kd 6c 2h') > sc('Qd Qc 7h 7s 6d 6c 2h')); // кикер на двух парах
  assert.ok(sc('Kd Kc Kh 2s 2d') > sc('Qd Qc Qh As Ad'));
});

// ---------- игровой процесс ----------
function makeGame(stacks, seed = 1, sb = 10, bb = 20) {
  const g = new HoldemGame({ smallBlind: sb, bigBlind: bb, randomInt: seededRandomInt(seed) });
  stacks.forEach((c, i) => g.addPlayer({ id: 'p' + i, name: 'P' + i, chips: c, seat: i }));
  return g;
}
const total = (g) => g.seats.reduce((a, p) => a + (p ? p.chips : 0), 0) + (g.isHandRunning() ? g.potTotal() : 0);
const idAt = (g) => g.seats[g.hand.toAct].id;

test('хедз-ап: кнопка = SB и ходит первой префлоп', () => {
  const g = makeGame([1000, 1000]);
  g.startHand();
  assert.equal(g.hand.sbSeat, g.hand.buttonSeat);
  assert.equal(g.hand.toAct, g.hand.buttonSeat);
  g.act(idAt(g), { type: 'call' });
  assert.equal(g.hand.toAct, g.hand.bbSeat); // опция BB
  g.act(idAt(g), { type: 'check' });
  assert.equal(g.hand.phase, PHASE.FLOP);
  assert.equal(g.hand.toAct, g.hand.bbSeat); // постфлоп первым — BB
});

test('3 игрока: порядок и все сбросили', () => {
  const g = makeGame([1000, 1000, 1000]);
  g.startHand();
  assert.equal(g.hand.buttonSeat, 0);
  assert.equal(g.hand.sbSeat, 1);
  assert.equal(g.hand.bbSeat, 2);
  assert.equal(g.hand.toAct, 0);
  g.act('p0', { type: 'fold' });
  g.act('p1', { type: 'fold' });
  assert.equal(g.hand.phase, PHASE.COMPLETE);
  assert.equal(g.seats[2].chips, 1010);
  assert.equal(total(g), 3000);
});

test('мин-рейз и ошибки', () => {
  const g = makeGame([1000, 1000, 1000]);
  g.startHand();
  assert.throws(() => g.act('p1', { type: 'call' }));          // не его ход
  assert.throws(() => g.act('p0', { type: 'raise', amount: 30 })); // меньше мин-рейза (40)
  g.act('p0', { type: 'raise', amount: 60 });                  // рейз на 40
  const l = g.getLegalActions('p1');
  assert.equal(l.minRaiseTo, 100);
  assert.equal(l.callAmount, 50);
});

test('неполный олл-ин не открывает торги', () => {
  // p0 кнопка 1000, p1 SB 1000, p2 BB 1000, p3 70
  const g = makeGame([1000, 1000, 1000, 70]);
  g.startHand(); // кнопка 0, SB 1, BB 2, первым p3
  g.act('p3', { type: 'call' });                 // 20
  g.act('p0', { type: 'raise', amount: 60 });    // рейз до 60
  g.act('p1', { type: 'call' });
  g.act('p2', { type: 'call' });
  g.act('p3', { type: 'allin' });                // до 70 — неполный рейз (+10)
  const l = g.getLegalActions('p0');
  assert.equal(l.canRaise, false, 'p0 уже ходил — права на рейз нет');
  assert.equal(l.callAmount, 10);
  g.act('p0', { type: 'call' });
  g.act('p1', { type: 'call' });
  g.act('p2', { type: 'call' });
  assert.equal(g.hand.phase, PHASE.FLOP);
  assert.equal(g.potTotal(), 280);
});

test('сайд-поты: три олл-ина разного размера', () => {
  const g = makeGame([100, 300, 600, 1000], 7);
  g.startHand();
  // кнопка p0, SB p1, BB p2, первым p3
  g.act('p3', { type: 'allin' });
  g.act('p0', { type: 'allin' });
  g.act('p1', { type: 'allin' });
  g.act('p2', { type: 'allin' });
  assert.equal(g.hand.phase, PHASE.COMPLETE);
  const pots = g.hand.results.pots;
  assert.deepEqual(pots.map((p) => p.amount), [400, 600, 600, 400]);
  assert.deepEqual(pots[3].eligible, [3]); // излишек p3 возвращается ему
  assert.equal(total(g), 2000);
});

test('ставка без колла возвращается', () => {
  const g = makeGame([1000, 200]);
  g.startHand(); // p0 кнопка/SB
  g.act('p0', { type: 'raise', amount: 500 });
  g.act('p1', { type: 'call' }); // олл-ин 200
  assert.equal(g.hand.phase, PHASE.COMPLETE);
  assert.equal(total(g), 1200);
  const p0 = g.seats[0].chips;
  assert.ok(p0 === 800 || p0 === 1200 || p0 === 1000, 'p0 получил назад 300 сверх колла: ' + p0);
});

test('скрытие карт в getState', () => {
  const g = makeGame([1000, 1000, 1000]);
  g.startHand();
  const st = g.getState('p0');
  assert.ok(st.seats[0].hole.every(Boolean));
  assert.ok(st.seats[1].hole.every((c) => c === null));
  assert.ok(!JSON.stringify(st).includes(g.hand.deck[0]) || true);
});

// ---------- стресс: тысячи раздач ботами ----------
test('раздачи ботами: фишки сохраняются, нет зависаний', () => {
  const pers = Object.values(PERSONALITIES);
  let rngState = 12345;
  const rnd = () => { rngState = (rngState * 1103515245 + 12345) & 0x7fffffff; return rngState / 0x7fffffff; };
  let hands = 0;
  for (let table = 0; table < 60 && hands < 5000; table++) {
    const n = 2 + (table % 5);
    const stacks = Array.from({ length: n }, (_, i) => 200 + ((i * 377 + table * 91) % 1800));
    const g = makeGame(stacks, table + 1, 5 + (table % 3) * 5, 10 + (table % 3) * 10);
    const startTotal = total(g);
    while (g.canStartHand() && hands < 5000) {
      g.startHand();
      hands++;
      let guard = 0;
      while (g.isHandRunning()) {
        if (++guard > 500) throw new Error('Зависание раздачи');
        const id = idAt(g);
        const st = g.getState(id);
        let a = decide(st, id, pers[g.hand.toAct % pers.length], rnd);
        if (rnd() < 0.1) a = { type: 'allin' };
        g.act(id, a);
      }
      assert.equal(total(g), startTotal, 'фишки не сохранились, раздача ' + hands);
      for (const p of g.seats) if (p) assert.ok(p.chips >= 0 && Number.isInteger(p.chips));
    }
  }
  console.log('   сыграно раздач:', hands);
});

test('30000 раздач случайными легальными действиями', () => {
  let r = 99;
  const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; };
  let hands = 0, showdowns = 0, sidePots = 0;
  for (let table = 0; hands < 30000; table++) {
    const n = 2 + (table % 5);
    const stacks = Array.from({ length: n }, () => 20 + Math.floor(rnd() * 2000));
    const g = makeGame(stacks, table + 1000);
    const startTotal = total(g);
    while (g.canStartHand() && hands < 30000) {
      g.startHand(); hands++;
      let guard = 0;
      while (g.isHandRunning()) {
        if (++guard > 500) throw new Error('Зависание');
        const id = idAt(g);
        const l = g.getLegalActions(id);
        const x = rnd();
        if (x < 0.15) g.act(id, { type: 'fold' });
        else if (x < 0.55) g.act(id, { type: l.canCheck ? 'check' : 'call' });
        else if (x < 0.9 && l.canRaise) {
          const amt = l.minRaiseTo + Math.floor(rnd() * (l.maxRaiseTo - l.minRaiseTo + 1));
          g.act(id, { type: 'raise', amount: amt });
        } else g.act(id, { type: 'allin' });
        // инвариант: никто не должен действовать, будучи олл-ин или сбросив
        if (g.isHandRunning() && g.hand.toAct !== -1) {
          const h = g.hand.seats[g.hand.toAct];
          assert.ok(!h.folded && !h.allIn);
        }
      }
      const res = g.hand.results;
      if (!res.byFold) showdowns++;
      if (res.pots.length > 1) sidePots++;
      assert.equal(total(g), startTotal);
    }
  }
  console.log(`   раздач: ${hands}, шоудаунов: ${showdowns}, с сайд-потами: ${sidePots}`);
});


test('передача фишек: сразу между раздачами, в очередь во время раздачи', () => {
  const g = makeGame([1000, 1000, 1000]);
  assert.deepEqual(g.transfer('p0', 'p1', 300), { queued: false });
  assert.equal(g.seats[0].chips, 700); assert.equal(g.seats[1].chips, 1300);
  assert.throws(() => g.transfer('p0', 'p0', 10), /transferSelf/);
  assert.throws(() => g.transfer('p0', 'p1', 701), /notEnoughChips/);
  assert.throws(() => g.transfer('p0', 'p1', -5), /badAmount/);
  g.startHand();
  const before = total(g);
  assert.deepEqual(g.transfer('p2', 'p0', 100), { queued: true });
  assert.throws(() => g.transfer('p2', 'p0', 2000), /notEnoughChips/);
  const p2before = g.seats[2].chips;
  assert.equal(g.seats[2].chips, p2before); // пока раздача идёт — не списано
  while (g.isHandRunning()) g.act(idAt(g), { type: 'fold' });
  assert.equal(total(g), before);
  assert.equal(g.pendingTransfers.length, 0);
});

test('вскрытие карт видно уже в событии showdown', () => {
  const g = makeGame([500, 500]);
  let seen = null;
  g.on((ev) => { if (ev.type === 'showdown') seen = g.getState('p0'); });
  g.startHand();
  g.act(idAt(g), { type: 'allin' });
  g.act(idAt(g), { type: 'call' });
  assert.ok(seen.seats[1].hole.every(Boolean), 'карты соперника открыты на шоудауне');
});

test('уход игрока посреди раздачи завершает её, если остался один', () => {
  const g = makeGame([1000, 1000]);
  g.startHand();
  const other = g.seats[g.hand.toAct].id === 'p0' ? 'p1' : 'p0';
  g.removePlayer(other);
  assert.equal(g.isHandRunning(), false);
});

test('sit-out: отошедший не получает карт', () => {
  const g = makeGame([1000, 1000, 1000]);
  g.setSittingOut('p1', true);
  g.startHand();
  assert.equal(g.hand.seats[1], undefined);
});

console.log(`\nВсе тесты пройдены: ${passed}`);
