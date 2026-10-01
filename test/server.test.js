// Сквозной тест сервера: несколько клиентов по WebSocket играют за одним столом.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL = `ws://localhost:${PORT}/ws`;
const srv = spawn(process.execPath, ['server/server.js'], {
  env: { ...process.env, PORT, TURN_MS: '1200', NEXT_HAND_MS: '150', BOT_MIN_MS: '20', BOT_MAX_MS: '40', STATS_FILE: `/tmp/holdem-stats-${PORT}.json` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => srv.stdout.once('data', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('✓', name); };

class Client {
  constructor(name, token) {
    this.name = name; this.token = token; this.msgs = []; this.state = null; this.seq = 0; this.waiters = new Map();
    this.auto = false; this.leaks = 0;
  }
  async open() {
    this.ws = new WebSocket(URL);
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); });
    this.ws.on('message', (d) => this.onMsg(JSON.parse(d)));
    const w = await this.req({ type: 'hello', token: this.token, name: this.name, avatar: 'h1' });
    this.id = w.playerId;
  }
  req(m) {
    const reqId = ++this.seq;
    this.ws.send(JSON.stringify({ ...m, reqId }));
    return new Promise((res, rej) => this.waiters.set(reqId, { res, rej }));
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  onMsg(m) {
    this.msgs.push(m);
    if (m.reqId && this.waiters.has(m.reqId)) {
      const w = this.waiters.get(m.reqId); this.waiters.delete(m.reqId);
      return m.type === 'error' ? w.rej(Object.assign(new Error(m.code), { code: m.code })) : w.res(m);
    }
    if (m.state) {
      this.state = m.state;
      // Чужие карты не должны приходить до вскрытия
      for (const s of m.state.seats) {
        if (!s || s.id === this.id || !s.hole) continue;
        const open = s.hole.some(Boolean);
        if (open && !['showdown', 'complete'].includes(m.state.phase)) this.leaks++;
      }
      if (this.auto && m.state.legal && m.state.legal.seat === m.state.seats.findIndex((x) => x && x.id === this.id)) {
        const l = m.state.legal;
        const r = Math.random();
        const action = r < 0.15 ? { type: 'fold' } : r < 0.95 ? { type: l.canCheck ? 'check' : 'call' }
          : l.canRaise ? { type: 'raise', amount: l.minRaiseTo } : { type: l.canCheck ? 'check' : 'call' };
        setTimeout(() => this.send({ type: 'act', action }), 5);
      }
    }
  }
  close() { this.ws.close(); }
}

const total = (st) => st.seats.reduce((a, s) => a + (s ? s.chips + (st.phase === 'complete' ? 0 : s.committed) : 0), 0);

try {
  const A = new Client('Anna', 'a'.repeat(32));
  const B = new Client('Bohdan', 'b'.repeat(32));
  await A.open(); await B.open();
  assert.ok(A.id && B.id && A.id !== B.id);
  ok('hello: выдан playerId');

  const created = await A.req({ type: 'create', blinds: '5/10', stack: 10000, bots: 1 });
  assert.match(created.tableId, /^[A-Z2-9]{6}$/);
  ok('создан стол ' + created.tableId);

  await assert.rejects(B.req({ type: 'join', tableId: 'ZZZZZZ' }), /tableNotFound/);
  const joined = await B.req({ type: 'join', tableId: created.tableId.toLowerCase() });
  assert.equal(joined.tableId, created.tableId);
  ok('вход по ID (регистр не важен), неверный ID — tableNotFound');

  // Профиль и передача фишек до старта (раздача начнётся почти сразу — допускаем очередь)
  const prof = await A.req({ type: 'profile', playerId: B.id });
  assert.equal(prof.profile.name, 'Bohdan');
  ok('профиль игрока');

  A.auto = true; B.auto = true;
  await sleep(4000);
  const hands = A.state.handNumber;
  assert.ok(hands >= 3, 'сыграно раздач: ' + hands);
  assert.equal(A.leaks + B.leaks, 0, 'утечка чужих карт');
  ok(`за 4 с сыграно ${hands} раздач, чужие карты не утекали`);

  const t0 = total(A.state);
  assert.equal(t0, 30000, 'фишки на столе сохраняются: ' + t0);
  ok('сумма фишек за столом не меняется');

  // Передача фишек
  const bSeat = A.state.seats.find((s) => s && s.id === B.id);
  const aSeat = A.state.seats.find((s) => s && s.id === A.id);
  if (aSeat.chips > 10) {
    A.send({ type: 'transfer', to: B.id, amount: 10 });
    await sleep(300);
    const toast = A.msgs.find((m) => m.type === 'toast' && /toast\.sent/.test(m.key));
    assert.ok(toast, 'тост об отправке');
    ok('передача фишек: ' + toast.key);
  }
  void bSeat;

  // Сигналинг WebRTC
  A.send({ type: 'rtc', to: B.id, data: { hello: 1 } });
  await sleep(150);
  assert.ok(B.msgs.some((m) => m.type === 'rtc' && m.from === A.id && m.data.hello === 1));
  ok('WebRTC-сигналы пересылаются между игроками стола');

  // Медиа-статус
  A.send({ type: 'media', cam: true, mic: false });
  await sleep(150);
  assert.deepEqual(B.state.seats.find((s) => s && s.id === A.id).meta.media, { cam: true, mic: false });
  ok('статус камеры виден соперникам');

  // Таймаут: B перестаёт ходить
  B.auto = false;
  await sleep(4500);
  if (!(B.msgs.some((m) => m.type === 'toast' && /timeout/.test(m.key)) || A.msgs.some((m) => m.type === 'timeout'))) {
    const st = A.state;
    console.log('DEBUG', st.phase, st.handNumber, 'toAct', st.toAct, st.seats.map((x) => x && [x.name, x.chips, x.folded, x.sittingOut, x.inHand]));
    console.log('last msgs', A.msgs.slice(-5).map((m) => m.type + ':' + (m.ev ? m.ev.type : m.seat)));
  }
  assert.ok(B.msgs.some((m) => m.type === 'toast' && /timeout/.test(m.key)) || A.msgs.some((m) => m.type === 'timeout'));
  ok('по таймеру ход делается автоматически');

  // Переподключение: тот же токен — то же место
  const seatBefore = A.state.seats.findIndex((s) => s && s.id === B.id);
  B.close();
  await sleep(300);
  assert.equal(A.state.seats[seatBefore].meta.connected, false);
  const B2 = new Client('Bohdan', 'b'.repeat(32));
  await B2.open();
  assert.equal(B2.id, B.id);
  await B2.req({ type: 'join', tableId: created.tableId });
  await sleep(200);
  assert.equal(A.state.seats.findIndex((s) => s && s.id === B.id), seatBefore);
  assert.equal(A.state.seats[seatBefore].meta.connected, true);
  ok('переподключение возвращает на то же место');

  // Статистика
  const prof2 = await B2.req({ type: 'profile', playerId: A.id });
  assert.ok(prof2.profile.hands >= hands - 1);
  assert.ok(prof2.profile.wins <= prof2.profile.hands);
  ok(`статистика: ${prof2.profile.hands} раздач, ${prof2.profile.wins} побед`);

  // Уход
  B2.send({ type: 'leave' });
  await sleep(300);
  assert.equal(A.state.seats.some((s) => s && s.id === B.id), false);
  ok('уход из-за стола освобождает место');

  A.close(); B2.close();
  console.log(`\nСервер: все тесты пройдены (${passed})`);
} finally {
  srv.kill();
}
