import { PHASE, PokerError } from '../engine/game.js';
import { evaluate } from '../engine/evaluator.js';
import { avatarSVG, AVATAR_COUNT } from './avatars.js';
import { LocalTable, BOT_LAYOUT, BOT_NAMES } from './local-table.js';
import { NetTable, NetError, defaultServerUrl } from './net-table.js';
import { startHost, guestTransport } from './p2p.js';
import { Media } from './media.js';
import { LANGS, setLang, detectLang, t, th, fmt, handName } from '../i18n/i18n.js';

// ================= константы =================
const TURN_SECONDS = 30;
// Визуальные позиции мест (% от стола), по часовой стрелке от «меня» внизу
const POS_WIDE = [[50, 86], [9, 64], [17, 13], [50, 6], [83, 13], [91, 64]];
const POS_TALL = [[50, 88], [16, 66], [16, 28], [50, 7], [84, 28], [84, 66]];
const CENTER = [50, 46];
const BLINDS = { '5/10': [5, 10], '10/20': [10, 20], '25/50': [25, 50], '50/100': [50, 100] };
const STACKS = [1000, 2000, 5000, 10000];
const DEAL_STEP = 110;
const FLY_MS = 380;
const SPEED = { slow: 1.5, normal: 1, fast: 0.45 };

// ================= настройки игрока =================
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('holdem.settings') || '{}'); } catch {}
  const lang = s.lang || detectLang();
  setLang(lang);
  // Без своего сервера (Netlify и т. п.) сеть работает напрямую между браузерами;
  // старое значение по умолчанию «ws://localhost…» больше не навязываем
  if (!window.HOLDEM_WS && /^wss?:\/\/localhost:8080\/ws$/.test(s.server || '')) s.server = '';
  return {
    avatar: 'h3', bots: 5, stack: 2000, blinds: '10/20', speed: 'normal',
    server: window.HOLDEM_WS ? defaultServerUrl() : '', onlineBots: 0, tab: 'local',
    ...s,
    lang,
    name: (s.name && s.name !== 'Вы') ? s.name : `${t('app.player')} ${100 + Math.floor(Math.random() * 900)}`,
  };
}
function saveSettings() { try { localStorage.setItem('holdem.settings', JSON.stringify(settings)); } catch {} }
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

let settings = loadSettings();

// ================= разметка =================
const root = document.getElementById('app');
root.innerHTML = `
<div class="app" id="shell">
  <header class="topbar">
    <div class="brand">Hold'em <span>NL</span></div>
    <div class="meta">
      <div><span data-t="app.blinds"></span> <b id="m-blinds">—</b></div>
      <div class="hide-sm"><span data-t="app.hand"></span> <b id="m-hand">—</b></div>
      <button class="table-chip" id="m-table" hidden></button>
    </div>
    <div class="spacer"></div>
    <div class="media-btns" id="media-btns" hidden>
      <button class="icon-btn" id="btn-cam"></button>
      <button class="icon-btn" id="btn-mic"></button>
    </div>
    <select class="lang-select" id="lang-top"></select>
    <button class="ghost" id="btn-log" aria-controls="log" aria-expanded="false"></button>
    <button class="ghost" id="btn-lobby" data-t="app.lobby"></button>
  </header>
  <main class="table-wrap">
    <div class="table" id="table" dir="ltr">
      <div class="felt"></div>
      <div class="deck" id="deck" hidden></div>
      <div class="center">
        <div class="board" id="board"></div>
        <div class="pot"><small data-t="table.pot"></small><span id="pot-v">0</span></div>
        <div class="banner" id="banner"></div>
      </div>
      <div id="seats"></div>
      <div id="bets"></div>
      <div class="dealer" id="dealer" hidden>D</div>
      <div id="fx" class="fx"></div>
    </div>
  </main>
  <section class="actions" id="actions"></section>
  <aside class="log" id="log">
    <div class="log-head"><h2 data-t="log.title"></h2><button class="ghost" id="btn-log-close" data-t="log.hide"></button></div>
    <div class="log-body" id="log-body"></div>
  </aside>
</div>
<div class="overlay" id="overlay" hidden></div>
<div class="toast" id="toast" hidden></div>`;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5zM15 10.5l5-3v9l-5-3z" fill="currentColor"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  off: '<svg class="slash" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

// ================= карты =================
const SUIT_CHAR = { s: '♠', h: '♥', d: '♦', c: '♣' };
const rankLabel = (r) => (r === 'T' ? '10' : r);
function cardEl(card, extra = '') {
  if (card === null) return el('div', `card back ${extra}`);
  if (card === undefined) return el('div', `card slot ${extra}`);
  const red = card[1] === 'h' || card[1] === 'd';
  const s = SUIT_CHAR[card[1]];
  const e = el('div', `card ${red ? 'red' : ''} ${extra}`,
    `<span class="r">${rankLabel(card[0])}</span><span class="s1">${s}</span><span class="s">${s}</span>`);
  e.dataset.card = card;
  e.setAttribute('aria-label', rankLabel(card[0]) + s);
  return e;
}
const miniCards = (cards) => `<span class="mini" dir="ltr">${cards.map((c) =>
  `<span class="${c[1] === 'h' || c[1] === 'd' ? 'red' : ''}">${rankLabel(c[0])}${SUIT_CHAR[c[1]]}</span>`).join('')}</span>`;

// ================= состояние клиента =================
let table = null;          // LocalTable | NetTable
let media = null;          // Media (только онлайн)
let queue = [];
let pumping = false;
let lastSnap = null;
let clock = null;          // { seat, total, remaining, paused, at }
let shownBoard = 0;
let highlight = { winners: [], cards: [] };
let session = 0;
let logEntries = [];       // { html: () => string, cls } — перерисовываются при смене языка
let bannerFn = null;
let profileOpenFor = null;
const seatEls = [];

const speed = () => (table && table.mode === 'local' ? SPEED[settings.speed] || 1 : 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const myId = () => (table ? table.myId : null);
const mySeat = (st) => { const i = st ? st.seats.findIndex((s) => s && s.id === myId()) : -1; return i < 0 ? 0 : i; };
const visualIndex = (st, seat) => (seat - mySeat(st) + 6) % 6;

// ================= статические тексты и язык =================
function applyStaticTexts() {
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = t(n.dataset.t); });
  $('btn-cam').title = t(media && media.cam ? 'media.camOff' : 'media.camOn');
  $('btn-mic').title = t(media && media.mic ? 'media.micOff' : 'media.micOn');
  updateLogButton();
  const sel = $('lang-top');
  if (!sel.options.length) for (const l of LANGS) sel.appendChild(new Option(l.code.toUpperCase(), l.code));
  sel.value = settings.lang;
  sel.setAttribute('aria-label', t('app.language'));
}

function changeLang(code) {
  settings.lang = setLang(code);
  saveSettings();
  applyStaticTexts();
  rebuildLog();
  if (bannerFn) $('banner').textContent = bannerFn();
  if (lastSnap) { render(lastSnap); renderActions(); }
  if (!$('overlay').hidden && $('setup')) showSetup(!table);
}
$('lang-top').addEventListener('change', (e) => changeLang(e.target.value));

// ================= запуск игры =================
function teardown() {
  session++;
  if (table) table.destroy();
  if (media) media.destroy();
  table = null; media = null;
  queue = []; pumping = false; clock = null; shownBoard = 0;
  highlight = { winners: [], cards: [] };
  bannerFn = null; $('banner').textContent = '';
  $('fx').innerHTML = '';
  logEntries = []; rebuildLog();
  $('media-btns').hidden = true;
  $('m-table').hidden = true;
}

function startLocal() {
  teardown();
  const [sb, bb] = BLINDS[settings.blinds] || [10, 20];
  table = new LocalTable({ ...settings, sb, bb }, { turnSeconds: TURN_SECONDS });
  wire(table);
  $('m-blinds').textContent = `${sb}/${bb}`;
  table.start();
}

// Есть адрес сервера — играем через него. Нет — напрямую между браузерами (P2P), стол живёт у создателя.
const serverUrl = () => settings.server || (window.HOLDEM_WS ? defaultServerUrl() : '');
let hosting = false;

async function startOnline(kind, tableId) {
  const profile = { name: settings.name, avatar: settings.avatar, lang: settings.lang };
  let net;
  if (serverUrl()) net = new NetTable(serverUrl(), profile);
  else if (kind === 'create') {
    const host = await startHost();
    net = new NetTable(() => host.loopback(), profile);
    net.onDestroy = () => { host.destroy(); hosting = false; };
  } else net = new NetTable(() => guestTransport(tableId), profile);
  try {
    await net.connect();
    if (kind === 'create') await net.create({ blinds: settings.onlineBlinds || settings.blinds, stack: settings.onlineStack || settings.stack, bots: settings.onlineBots });
    else await net.join(tableId);
  } catch (e) {
    net.closed = true;
    if (net.onDestroy) net.onDestroy();
    throw e;
  }
  teardown();
  hosting = !serverUrl() && kind === 'create';
  table = net;
  wire(net);
  if (Media.supported()) {
    media = new Media(net);
    media.on('change', () => { if (lastSnap) render(lastSnap); applyStaticTexts(); refreshMediaButtons(); });
  }
  $('media-btns').hidden = false;
  refreshMediaButtons();
  const snap = net.snap();
  const { smallBlind, bigBlind } = snap.config;
  $('m-blinds').textContent = `${smallBlind}/${bigBlind}`;
  showTableChip(net.tableId);
  try { history.replaceState(null, '', location.pathname + '#' + net.tableId); } catch {}
  onState(snap);
}

function wire(c) {
  const my = session;
  c.on('event', (ev, snap) => { if (my === session) { queue.push({ ev, snap }); pump(); } });
  c.on('state', (snap) => { if (my === session) onState(snap); });
  c.on('clock', (info) => { if (my === session) setClock(info); });
  c.on('toast', (key, params) => toast(t(key, params)));
  c.on('timeout', (id, name) => log(() => th('log.timeout', { name }), 'street'));
  c.on('waiting', () => renderActions());
  c.on('end', (won, n) => showEnd(won, n));
  c.on('status', (s) => toast(t(s === 'disconnected' ? 'err.disconnected' : 'toast.reconnected')));
}

function onState(snap) {
  if (pumping || queue.length) queue.push({ ev: { type: '_state' }, snap });
  else { render(snap); renderActions(); }
  syncPeers(snap);
}

function syncPeers(snap) {
  if (!media || !snap) return;
  media.sync(snap.seats.filter((s) => s && !s.isBot && s.meta && s.meta.connected !== false).map((s) => s.id));
}

// ================= очередь событий =================
// Сервер/движок работают мгновенно, клиент проигрывает события с паузами и снимком состояния на каждом шаге.
async function pump() {
  if (pumping) return;
  pumping = true;
  const my = session;
  while (queue.length) {
    const { ev, snap } = queue.shift();
    beforeRender(ev);
    onEvent(ev, snap);
    render(snap, ev);
    afterRender(ev);
    if (ev.type === 'playerJoined' || ev.type === 'playerLeft' || ev.type === '_state') syncPeers(snap);
    await sleep(delayFor(ev, snap));
    if (my !== session) return;
  }
  pumping = false;
  table.idle();
  if (lastSnap) render(lastSnap);
  renderActions();
}

function dealDuration(snap) {
  const n = snap.seats.filter((s) => s && s.inHand).length;
  return (n * 2 - 1) * DEAL_STEP + FLY_MS + 380;
}
function delayFor(ev, snap) {
  const k = speed();
  switch (ev.type) {
    case 'action': return (ev.action === 'fold' ? 450 : 550) * k;
    case 'street': return (ev.cards.length * 140 + 650) * k;
    case 'betsCollected': return 420;
    case 'dealHole': return dealDuration(snap) + 100;
    case 'showdown': return 1100 * k;
    case 'win': return 700;
    case 'handStart': return 300;
    default: return 0;
  }
}

// ================= таймер хода =================
function setClock(info) {
  clock = info ? { ...info, at: performance.now() } : null;
  if (lastSnap) updateRings();
  updateClockText();
}
function clockRemaining() {
  if (!clock) return 0;
  return clock.paused ? clock.remaining : Math.max(0, clock.remaining - (performance.now() - clock.at));
}
setInterval(updateClockText, 250);
function updateClockText() {
  const n = $('hero-clock');
  if (!n) return;
  if (!clock || !lastSnap || clock.seat !== mySeat(lastSnap)) { n.textContent = '—'; n.classList.remove('low'); return; }
  const left = Math.ceil(clockRemaining() / 1000);
  n.textContent = `0:${String(left).padStart(2, '0')}`;
  n.classList.toggle('low', left <= 10);
}

// ================= журнал =================
const STREET_KEY = { flop: 'log.flop', turn: 'log.turn', river: 'log.river' };
function log(html, cls = '') {
  logEntries.push({ html, cls });
  if (logEntries.length > 600) logEntries.splice(0, 100);
  appendLog(logEntries[logEntries.length - 1]);
}
function appendLog(e) {
  const body = $('log-body');
  body.appendChild(el('div', e.cls, e.html()));
  body.scrollTop = body.scrollHeight;
}
function rebuildLog() {
  $('log-body').innerHTML = '';
  for (const e of logEntries) appendLog(e);
}

function actionText(ev) {
  const amt = (n) => `<span class="num">${fmt(n)}</span>`;
  const base = {
    fold: () => t('act.fold'),
    check: () => t('act.check'),
    call: () => `${t('act.call')} ${amt(ev.amount)}`,
    bet: () => `${t('act.bet')} ${amt(ev.to)}`,
    raise: () => `${t('act.raiseTo')} ${amt(ev.to)}`,
  }[ev.action]();
  return ev.allIn ? `${base} · ${t('act.allin')}` : base;
}

function onEvent(ev, snap) {
  const nameOf = (seat) => (snap.seats[seat] ? snap.seats[seat].name : '—');
  const nameById = (id) => (snap.seats.find((s) => s && s.id === id) || {}).name || '—';
  const num = (n) => `<span class="num">${fmt(n)}</span>`;
  switch (ev.type) {
    case 'handStart': {
      const n = ev.hand, name = nameOf(ev.buttonSeat);
      $('m-hand').textContent = '#' + n;
      highlight = { winners: [], cards: [] };
      shownBoard = 0;
      bannerFn = null; $('banner').textContent = '';
      log(() => th('log.handStart', { n, name }), 'hand-sep');
      break;
    }
    case 'blind': {
      const name = nameOf(ev.seat), a = ev.amount;
      log(() => th(ev.kind === 'sb' ? 'log.sb' : 'log.bb', { name, amountHtml: num(a) }));
      break;
    }
    case 'dealHole': {
      const me = snap.seats[mySeat(snap)];
      if (me && me.id === myId() && me.hole && me.hole[0]) {
        const cards = me.hole.slice();
        log(() => `${t('log.yourCards')} ${miniCards(cards)}`);
      }
      break;
    }
    case 'action': {
      const name = nameOf(ev.seat), e = { ...ev };
      log(() => `<bdi>${esc(name)}</bdi>: ${actionText(e)}`);
      break;
    }
    case 'street': {
      const board = ev.board.slice(), key = STREET_KEY[ev.phase];
      log(() => `${t(key)}: ${miniCards(board)}`, 'street');
      break;
    }
    case 'showdown':
      for (const [seat, h] of Object.entries(ev.hands)) {
        const name = nameOf(seat), hole = h.hole.slice(), hd = { key: h.key, ranks: h.ranks };
        log(() => `<bdi>${esc(name)}</bdi>: ${miniCards(hole)} — ${esc(handName(hd))}`);
      }
      break;
    case 'win': {
      const multi = ev.pots.length > 1;
      const winners = [];
      for (const w of ev.winners) {
        const name = nameOf(w.seat), a = w.amount;
        if (w.uncalled) { log(() => th('log.returned', { name, amountHtml: num(a) })); continue; }
        const pi = w.potIndex;
        log(() => th('log.wins', { name, amountHtml: num(a) })
          + (multi ? ` (${pi === 0 ? t('log.mainPot') : t('log.sidePot', { n: pi })})` : ''), 'win');
        winners.push(w.seat);
      }
      highlight.winners = [...new Set(winners)];
      if (!ev.byFold && winners.length) {
        const h = ev.hands[winners[0]];
        highlight.cards = winners.flatMap((s) => ev.hands[s].best);
        const names = [...new Set(winners)].map(nameOf).join(' · ');
        const hd = { key: h.key, ranks: h.ranks };
        bannerFn = () => t('banner.wins', { name: names, hand: handName(hd) });
      } else if (winners.length) {
        const name = nameOf(winners[0]);
        bannerFn = () => t('banner.takesPot', { name });
      }
      if (bannerFn) $('banner').textContent = bannerFn();
      break;
    }
    case 'transfer': {
      const from = nameById(ev.from), to = nameById(ev.to), a = ev.amount;
      log(() => th('log.transfer', { from, to, amountHtml: num(a) }), 'win');
      break;
    }
    case 'transferQueued': {
      const from = nameById(ev.from), to = nameById(ev.to), a = ev.amount;
      log(() => th('log.transferQueued', { from, to, amountHtml: num(a) }), 'street');
      break;
    }
    case 'playerJoined': { const name = ev.name; if (table && table.mode === 'online') log(() => th('log.joined', { name }), 'street'); break; }
    case 'playerLeft': { const name = (lastSnap && (lastSnap.seats[ev.seat] || {}).name) || ''; if (name) log(() => th('log.left', { name }), 'street'); break; }
    case 'sitOut': { const name = nameOf(ev.seat); log(() => th(ev.value ? 'log.away' : 'log.back', { name }), 'street'); break; }
  }
}

// ================= анимации =================
function tableRect() { return $('table').getBoundingClientRect(); }
function pctToPx(p) { const r = tableRect(); return [r.width * p[0] / 100, r.height * p[1] / 100]; }
function positions() { return window.matchMedia('(max-width: 640px)').matches ? POS_TALL : POS_WIDE; }
const posOf = (st, seat) => positions()[visualIndex(st, seat)];
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

function flyNode(node, toPct, { scale = 0.6, ms = 380 } = {}) {
  const tr = tableRect();
  const r = node.getBoundingClientRect();
  const c = node.cloneNode(true);
  c.classList.remove('deal', 'fly', 'flip');
  Object.assign(c.style, {
    position: 'absolute', left: (r.left - tr.left) + 'px', top: (r.top - tr.top) + 'px',
    width: r.width + 'px', height: r.height + 'px', margin: 0, transform: 'none', animation: 'none',
    transition: `transform ${ms}ms cubic-bezier(.4,0,.6,1), opacity ${ms}ms ease-in`,
  });
  $('fx').appendChild(c);
  c.getBoundingClientRect();
  const [tx, ty] = pctToPx(toPct);
  c.style.transform = `translate(${tx - (r.left - tr.left) - r.width / 2}px, ${ty - (r.top - tr.top) - r.height / 2}px) scale(${scale})`;
  c.style.opacity = '0';
  setTimeout(() => c.remove(), ms + 60);
}

function chipsTo(seat, amount) {
  if (!lastSnap) return;
  const [x, y] = pctToPx(CENTER);
  const c = el('div', 'bet flying', `<span class="chip"></span>+${fmt(amount)}`);
  Object.assign(c.style, { left: x + 'px', top: y + 'px' });
  $('fx').appendChild(c);
  c.getBoundingClientRect();
  const [tx, ty] = pctToPx(posOf(lastSnap, seat));
  c.style.transform = `translate(calc(-50% + ${tx - x}px), calc(-50% + ${ty - y}px))`;
  setTimeout(() => { c.style.opacity = '0'; }, 650);
  setTimeout(() => c.remove(), 1000);
}

function beforeRender(ev) {
  if (ev.type === 'betsCollected') for (const b of [...$('bets').children]) flyNode(b, CENTER, { scale: 0.7 });
  if (ev.type === 'action' && ev.action === 'fold' && ev.id !== myId()) {
    const s = seatEls[ev.seat];
    if (s) for (const c of s.querySelectorAll('.hole .card')) flyNode(c, CENTER, { scale: 0.5 });
  }
}
function afterRender(ev) {
  if (ev.type === 'win') {
    const sums = {};
    for (const w of ev.winners) sums[w.seat] = (sums[w.seat] || 0) + w.amount;
    for (const [s, a] of Object.entries(sums)) chipsTo(+s, a);
  }
}

function animateDeal(snap) {
  const order = [];
  for (let i = 1; i <= 6; i++) {
    const s = (snap.buttonSeat + i) % 6;
    if (snap.seats[s] && snap.seats[s].inHand) order.push(s);
  }
  const tr = tableRect();
  const [cx, cy] = pctToPx(CENTER);
  const me = mySeat(snap);
  order.forEach((seat, j) => {
    const s = seatEls[seat];
    if (!s) return;
    s.querySelectorAll('.hole .card').forEach((card, r) => {
      const rc = card.getBoundingClientRect();
      card.style.setProperty('--fx', (cx - (rc.left - tr.left) - rc.width / 2) + 'px');
      card.style.setProperty('--fy', (cy - (rc.top - tr.top) - rc.height / 2) + 'px');
      card.style.setProperty('--delay', ((r * order.length + j) * DEAL_STEP) + 'ms');
      card.style.setProperty('--fly', FLY_MS + 'ms');
      card.classList.add('fly');
      if (seat === me && !card.classList.contains('back')) {
        card.style.setProperty('--flip-delay', ((order.length * 2 - 1) * DEAL_STEP + FLY_MS) + 'ms');
        card.classList.add('flip');
        card.appendChild(el('span', 'cover'));
      }
    });
  });
}

// ================= отрисовка стола =================
const TAG_KEY = { fold: 'act.fold', check: 'act.check', call: 'act.call', bet: 'act.bet', raise: 'act.raise', allin: 'act.allin' };

function seatEl(i) {
  if (seatEls[i]) return seatEls[i];
  const s = el('div', 'seat');
  s.dataset.seat = i;
  s.innerHTML = `
    <div class="pod">
      <button class="ava" type="button"><div class="ava-media"></div><div class="ring-slot"></div><div class="badges"></div></button>
      <div class="hole"></div>
      <span class="tag" hidden></span>
    </div>
    <div class="plate"><div class="name"></div><div class="chips"></div></div>
    <div class="handname"></div>`;
  s.querySelector('.ava').addEventListener('click', () => {
    const p = lastSnap && lastSnap.seats[i];
    if (p) openProfile(p.id);
  });
  $('seats').appendChild(s);
  seatEls[i] = s;
  return s;
}

function showVideoFor(p) {
  if (!media || !p || p.isBot) return false;
  if (p.id === myId()) return media.cam;
  return !!(p.meta && p.meta.media && p.meta.media.cam) && media.hasVideo(p.id);
}

function updateAvatar(s, p) {
  const box = s.querySelector('.ava-media');
  const video = showVideoFor(p);
  const key = `${p.id}|${p.meta?.avatar}|${video}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = '';
    if (video) {
      const v = media.videoEl(p.id);
      box.appendChild(v);
      v.play().catch(() => {});
    } else {
      box.innerHTML = avatarSVG(p.meta?.avatar ?? p.name);
    }
  }
  const m = (p.meta && p.meta.media) || {};
  const badges = s.querySelector('.badges');
  const bkey = `${!!m.mic}|${!!m.cam}`;
  if (badges.dataset.key !== bkey) {
    badges.dataset.key = bkey;
    badges.innerHTML = `${m.mic ? `<span class="badge">${ICON.mic}</span>` : ''}`;
  }
  s.querySelector('.ava').setAttribute('aria-label', p.name);
}

function updateRings() {
  const st = lastSnap;
  seatEls.forEach((s, i) => {
    if (!s) return;
    const slot = s.querySelector('.ring-slot');
    const p = st.seats[i];
    if (!p || !clock || clock.seat !== i || st.toAct !== i) { slot.innerHTML = ''; slot.dataset.key = ''; return; }
    const elapsed = (clock.total - clockRemaining()) / 1000;
    const key = `${clock.at}|${clock.paused}`;
    if (slot.dataset.key === key) return;
    slot.dataset.key = key;
    slot.innerHTML = `<svg class="ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5" pathLength="100"
      style="animation-duration:${clock.total / 1000}s;animation-delay:-${elapsed.toFixed(2)}s;animation-play-state:${clock.paused ? 'paused' : 'running'}"/></svg>`;
  });
}

function render(st, ev = null) {
  lastSnap = st;
  // борд
  const board = $('board');
  board.innerHTML = '';
  let newIdx = 0;
  for (let i = 0; i < 5; i++) {
    const c = st.board[i];
    const isNew = i >= shownBoard && c;
    const ce = cardEl(c, [isNew ? 'deal' : '', highlight.cards.length && c ? (highlight.cards.includes(c) ? 'hi' : 'dim') : ''].join(' '));
    if (isNew) ce.style.setProperty('--delay', (newIdx++ * 140) + 'ms');
    board.appendChild(ce);
  }
  shownBoard = st.board.length;
  $('pot-v').textContent = fmt(st.pot);
  $('deck').hidden = !(ev && ev.type === 'dealHole');

  const betsBox = $('bets');
  betsBox.innerHTML = '';
  const me = myId();
  for (let i = 0; i < 6; i++) {
    const p = st.seats[i];
    const s = seatEls[i];
    if (!p) { if (s) s.hidden = true; continue; }
    const node = seatEl(i);
    node.hidden = false;
    const [x, y] = posOf(st, i);
    const isMe = p.id === me;
    const side = isMe ? 'side-r' : x < 50 ? 'side-r' : x > 50 ? 'side-l' : 'side-r';
    node.className = ['seat', isMe ? 'hero' : '', y < 50 ? 'top' : 'bottom', side,
      st.toAct === i ? 'acting' : '', p.folded ? 'folded' : '',
      (!p.inHand && p.chips === 0) ? 'out' : '', p.sittingOut ? 'away' : '',
      highlight.winners.includes(i) ? 'winner' : ''].join(' ');
    node.style.left = x + '%';
    node.style.top = y + '%';

    updateAvatar(node, p);

    const hole = node.querySelector('.hole');
    hole.innerHTML = '';
    if (p.hole && !(p.folded && !isMe)) {
      for (const c of p.hole) {
        let extra = '';
        if (highlight.cards.length && c) extra = highlight.cards.includes(c) ? 'hi' : 'dim';
        hole.appendChild(cardEl(c, extra));
      }
    }

    const tag = node.querySelector('.tag');
    let tagText = '', tagCls = 'tag';
    if (p.allIn) { tagText = t('act.allin'); tagCls += ' allin'; }
    else if (p.lastAction && p.inHand) tagText = p.lastAction === 'sb' ? 'SB' : p.lastAction === 'bb' ? 'BB' : t(TAG_KEY[p.lastAction] || '');
    else if (p.sittingOut) tagText = t('table.away');
    tag.className = tagCls; tag.textContent = tagText; tag.hidden = !tagText;

    node.querySelector('.name').textContent = p.name;
    node.querySelector('.chips').textContent = p.chips === 0 && !p.inHand ? t('table.out') : fmt(p.chips);
    const hn = node.querySelector('.handname');
    hn.textContent = isMe && p.hole && p.hole[0] && !p.folded ? heroHandName(p.hole, st.board) : '';

    if (p.bet > 0) {
      const tall = positions() === POS_TALL;
      const k = tall ? (y < 50 ? 0.4 : isMe ? 0.42 : 0.3) : (y < 50 ? 0.55 : isMe ? 0.62 : 0.45);
      const [bx, by] = lerp([x, y], CENTER, k);
      const b = el('div', 'bet', `<span class="chip"></span>${fmt(p.bet)}`);
      b.style.left = bx + '%'; b.style.top = by + '%';
      betsBox.appendChild(b);
    }
  }

  if (ev && ev.type === 'dealHole') animateDeal(st);
  updateRings();

  const d = $('dealer');
  if (st.buttonSeat >= 0 && st.seats[st.buttonSeat]) {
    const p = posOf(st, st.buttonSeat);
    const [dx, dy] = lerp(p, CENTER, 0.36);
    d.style.left = (dx + (p[0] === 50 ? -9 : p[0] < 50 ? 5 : -5)) + '%';
    d.style.top = dy + '%';
    d.hidden = false;
  } else d.hidden = true;
}

function heroHandName(hole, board) {
  if (board.length >= 3) return handName(evaluate([...hole, ...board]));
  return hole[0][0] === hole[1][0] ? t('hand.pocketPair') : hole[0][1] === hole[1][1] ? t('hand.suited') : '';
}

// ================= панель действий =================
// Панель действий всегда одинаковая по составу и размеру: когда ход не ваш, кнопки просто неактивны,
// поэтому вёрстка стола не прыгает. Над кнопками — строка статуса фиксированной высоты.
function myLegal() {
  const st = lastSnap;
  if (!table || !st || pumping || !st.legal) return null;
  const p = st.seats[st.legal.seat];
  return p && p.id === myId() ? st.legal : null;
}

function renderActions() {
  const box = $('actions');
  box.innerHTML = '';
  const st = lastSnap;
  const legal = myLegal();

  // ----- строка статуса -----
  let note = '';
  if (!table || !st) note = t('table.pressStart');
  else if (!legal) {
    if (st.phase !== PHASE.WAITING && st.phase !== PHASE.COMPLETE && st.toAct >= 0 && st.seats[st.toAct]) note = t('table.waitFor', { name: st.seats[st.toAct].name });
    else if (table.mode === 'online' && st.seats.filter((x) => x && x.chips > 0 && !x.sittingOut).length < 2) note = t('table.waitingPlayers', { id: table.tableId });
    else if (st.handNumber > 0) note = t('table.nextHand');
  }
  const status = el('div', 'act-status' + (legal ? ' mine' : ''), note ? esc(note) : '&nbsp;');
  box.appendChild(status);

  const row = el('div', 'act-row' + (legal ? '' : ' idle'));
  box.appendChild(row);
  const btn = (cls, label, sub, key, fn, enabled) => {
    const b = el('button', 'btn ' + cls, `<span class="lbl">${esc(label)}</span><small>${sub || '&nbsp;'}</small>${key ? `<kbd>${key}</kbd>` : ''}`);
    b.type = 'button';
    b.disabled = !enabled;
    b.addEventListener('click', fn);
    return b;
  };

  // Что показать, когда ход не мой: прикидка по текущему состоянию стола
  const meSeat = st ? st.seats.findIndex((x) => x && x.id === myId()) : -1;
  const me = meSeat >= 0 ? st.seats[meSeat] : null;
  const bb = st ? st.config.bigBlind : 20;
  const step = st ? st.config.smallBlind : 10;
  const view = legal || (() => {
    const myBet = me ? me.bet : 0;
    const cur = st ? st.currentBet || 0 : 0;
    const chips = me ? me.chips : 0;
    const toCall = Math.max(0, Math.min(cur - myBet, chips));
    const minTo = Math.min(cur ? cur + bb : bb, myBet + chips) || bb;
    return { canCheck: toCall === 0, callAmount: toCall, canRaise: false, isBet: cur === 0,
      minRaiseTo: minTo, maxRaiseTo: Math.max(minTo, myBet + chips), currentBet: cur, pot: st ? st.pot : 0 };
  })();
  const myChips = me ? me.chips : 0;

  const clockEl = el('div', 'hero-clock', '—');
  clockEl.id = 'hero-clock';
  clockEl.title = t('table.timeLeft');
  row.appendChild(clockEl);
  row.appendChild(btn('fold', t('act.fold'), '', 'F', () => heroAct({ type: 'fold' }), !!legal));
  if (view.canCheck) row.appendChild(btn('', t('act.check'), '', 'C', () => heroAct({ type: 'check' }), !!legal));
  else row.appendChild(btn('', view.callAmount >= myChips && myChips > 0 ? t('act.callAllIn') : t('act.call'), fmt(view.callAmount), 'C', () => heroAct({ type: 'call' }), !!legal));

  // Блок ставки — всегда на месте, неактивен, если рейз сейчас невозможен
  const canRaise = !!(legal && legal.canRaise);
  const rb = el('div', 'raise-box' + (canRaise ? '' : ' off'));
  const range = el('input'); range.type = 'range'; range.id = 'raise-range';
  range.min = view.minRaiseTo; range.max = view.maxRaiseTo; range.step = step; range.disabled = !canRaise;
  range.setAttribute('aria-label', t('act.betSize'));
  const num = el('input'); num.type = 'number'; num.id = 'raise-num';
  num.min = view.minRaiseTo; num.max = view.maxRaiseTo; num.step = step; num.disabled = !canRaise;
  num.setAttribute('aria-label', t('act.amount'));
  const main = btn('primary', view.isBet ? t('act.bet') : t('act.raiseTo'), fmt(view.minRaiseTo), 'R', () => doRaise(), canRaise);
  const set = (v) => {
    v = Math.max(view.minRaiseTo, Math.min(view.maxRaiseTo, Math.round(v)));
    range.value = v; num.value = v;
    main.querySelector('small').textContent = canRaise && v === view.maxRaiseTo ? `${fmt(v)} · ${t('act.allin')}` : fmt(v);
  };
  const toCall = view.callAmount;
  const potTo = (f) => (view.isBet ? view.pot * f : view.currentBet + (view.pot + toCall) * f);
  const preflop = st && st.phase === PHASE.PREFLOP && !view.isBet;
  const options = preflop
    ? [['2.5 BB', bb * 2.5], ['3 BB', view.currentBet * 3], [t('act.pot'), potTo(1)], [t('act.allin'), view.maxRaiseTo]]
    : [[t('act.halfPot'), potTo(0.5)], ['¾', potTo(0.75)], [t('act.pot'), potTo(1)], [t('act.allin'), view.maxRaiseTo]];
  const presets = el('div', 'presets');
  for (const [label, v] of options) {
    const b = el('button', '', esc(label)); b.type = 'button'; b.disabled = !canRaise;
    b.addEventListener('click', () => set(v));
    presets.appendChild(b);
  }
  range.addEventListener('input', () => set(+range.value));
  num.addEventListener('change', () => set(+num.value));
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRaise(); });
  const doRaise = () => heroAct({ type: 'raise', amount: +num.value });
  set(view.minRaiseTo);
  rb.append(presets, range, num, main);
  row.appendChild(rb);
  updateClockText();
}

function errText(e) {
  if (e instanceof PokerError || e instanceof NetError) return t('err.' + e.code, e.params || {});
  return t('err.generic');
}

function heroAct(action) {
  if (!table) return;
  // Не убираем панель, а только блокируем — чтобы вёрстка не менялась
  $('actions').querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
  $('actions').querySelector('.act-row')?.classList.add('idle');
  try { table.act(action); }
  catch (e) { toast(errText(e)); renderActions(); }
}

document.addEventListener('keydown', (e) => {
  if (!table || !$('overlay').hidden || pumping) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const legal = myLegal();
  if (!legal) return;
  const k = e.key.toLowerCase();
  if (k === 'f') heroAct({ type: 'fold' });
  else if (k === 'c') heroAct({ type: legal.canCheck ? 'check' : 'call' });
  else if (k === 'r' && legal.canRaise) heroAct({ type: 'raise', amount: +$('raise-num').value });
});

let toastTimer;
function toast(msg) {
  const n = $('toast'); n.textContent = msg; n.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (n.hidden = true), 2600);
}

// ================= журнал: показать / скрыть =================
function updateLogButton() {
  const open = $('shell').classList.contains('log-open');
  $('btn-log').textContent = open && !isNarrow() ? t('app.hideLog') : t('app.log');
  $('btn-log').setAttribute('aria-expanded', String(open));
}
function setLogOpen(open, remember = true) {
  $('shell').classList.toggle('log-open', open);
  updateLogButton();
  if (remember && !isNarrow()) { try { localStorage.setItem('holdem.log', open ? '1' : '0'); } catch {} }
  requestAnimationFrame(() => lastSnap && render(lastSnap));
}
$('btn-log').addEventListener('click', () => setLogOpen(!$('shell').classList.contains('log-open')));
$('btn-log-close').addEventListener('click', () => setLogOpen(false));
(function initLog() {
  let open = !isNarrow();
  try { if (open) open = localStorage.getItem('holdem.log') !== '0'; } catch {}
  setLogOpen(open, false);
})();

// ================= ID стола и камера в шапке =================
function inviteLink(id) {
  if (/^https?:$/.test(location.protocol) && location.host) return `${location.origin}${location.pathname}#${id}`;
  return id;
}
function showTableChip(id) {
  const c = $('m-table');
  c.hidden = false;
  c.innerHTML = `<span>${esc(t('app.table'))}</span> <b>${esc(id)}</b> ${ICON.copy}`;
  c.title = t('app.copy');
  c.onclick = () => copyText(inviteLink(id));
}
function copyText(text) {
  const done = () => toast(t('app.copied') + ': ' + text);
  try {
    navigator.clipboard.writeText(text).then(done, () => toast(text));
  } catch { toast(text); }
}

function refreshMediaButtons() {
  const cam = $('btn-cam'), mic = $('btn-mic');
  const on = (x) => (media ? media[x] : false);
  cam.innerHTML = ICON.cam + (on('cam') ? '' : ICON.off);
  mic.innerHTML = ICON.mic + (on('mic') ? '' : ICON.off);
  cam.classList.toggle('on', on('cam'));
  mic.classList.toggle('on', on('mic'));
  cam.title = t(on('cam') ? 'media.camOff' : 'media.camOn');
  mic.title = t(on('mic') ? 'media.micOff' : 'media.micOn');
  cam.setAttribute('aria-label', cam.title);
  mic.setAttribute('aria-label', mic.title);
}
async function toggleMedia(kind) {
  if (!table || table.mode !== 'online') return toast(t('toast.mediaOnlineOnly'));
  if (!Media.secure()) return toast(t('toast.mediaInsecure'));
  if (!media) return toast(t('toast.mediaDenied'));
  try { await (kind === 'cam' ? media.setCam(!media.cam) : media.setMic(!media.mic)); }
  catch { toast(t('toast.mediaDenied')); }
  refreshMediaButtons();
  if (profileOpenFor) openProfile(profileOpenFor);
}
$('btn-cam').addEventListener('click', () => toggleMedia('cam'));
$('btn-mic').addEventListener('click', () => toggleMedia('mic'));

// ================= карточка игрока =================
async function openProfile(id) {
  if (!table) return;
  let pr;
  try { pr = await table.profile(id); } catch (e) { return toast(errText(e)); }
  profileOpenFor = id;
  const isMe = id === myId();
  const o = $('overlay');
  const rate = pr.hands ? Math.round((pr.wins / pr.hands) * 100) : 0;
  const style = pr.isBot && pr.meta && pr.meta.style ? t('style.' + pr.meta.style) : '';
  const sub = isMe ? t('profile.you') : pr.isBot ? `${t('profile.bot')}${style ? ' · ' + style : ''}` : '';
  const myChips = (lastSnap && lastSnap.seats.find((s) => s && s.id === myId()) || {}).chips || 0;
  const canShare = !isMe && myChips > 0;
  const human = !pr.isBot && !isMe && table.mode === 'online';
  const muted = media && media.muted.has(id);
  o.innerHTML = `
  <div class="dialog profile" role="dialog" aria-modal="true" aria-labelledby="pf-name">
    <div class="pf-media" id="pf-media"></div>
    <div class="pf-head">
      <h2 id="pf-name">${esc(pr.name)}</h2>
      ${sub ? `<div class="pf-sub">${esc(sub)}</div>` : ''}
    </div>
    <dl class="pf-stats">
      <div><dt>${esc(t('profile.hands'))}</dt><dd>${fmt(pr.hands)}</dd></div>
      <div><dt>${esc(t('profile.winRate'))}</dt><dd>${fmt(rate)}%</dd></div>
      <div><dt>${esc(t('profile.biggest'))}</dt><dd>${fmt(pr.biggest)}</dd></div>
      <div><dt>${esc(t('profile.chips'))}</dt><dd>${fmt(pr.chips)}</dd></div>
    </dl>
    ${canShare ? `
    <div class="field pf-share">
      <label for="pf-amount">${esc(t('profile.share'))}</label>
      <div class="pf-row">
        <input id="pf-amount" type="number" min="1" max="${myChips}" step="1" value="${Math.max(1, Math.round(myChips * 0.1))}" inputmode="numeric">
        <button class="btn primary" id="pf-send" type="button">${esc(t('profile.send'))}</button>
      </div>
      <div class="presets">${[10, 25, 50, 100].map((p) => `<button type="button" data-p="${p}">${p}%</button>`).join('')}</div>
      <p class="note">${esc(t('profile.shareNote'))}</p>
    </div>` : ''}
    ${isMe && table.mode === 'online' ? `
    <div class="pf-row">
      <button class="ghost" id="pf-cam" type="button">${esc(t(media && media.cam ? 'media.camOff' : 'media.camOn'))}</button>
      <button class="ghost" id="pf-mic" type="button">${esc(t(media && media.mic ? 'media.micOff' : 'media.micOn'))}</button>
    </div>` : ''}
    ${human ? `<button class="ghost" id="pf-mute" type="button">${esc(t(muted ? 'profile.unmute' : 'profile.muteForMe'))}</button>` : ''}
    <button class="ghost" id="pf-close" type="button">${esc(t('profile.close'))}</button>
  </div>`;
  o.hidden = false;
  table.pauseClock();

  // Крупно: видео, если включена камера, иначе аватар
  const box = $('pf-media');
  const seat = lastSnap && lastSnap.seats.find((s) => s && s.id === id);
  if (seat && showVideoFor(seat)) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true;
    v.srcObject = isMe ? media.local : media.peers.get(id).stream;
    if (isMe) v.classList.add('self');
    box.appendChild(v);
    v.play().catch(() => {});
  } else box.innerHTML = avatarSVG(pr.meta?.avatar ?? pr.name);

  const close = () => { o.hidden = true; o.innerHTML = ''; profileOpenFor = null; table && table.resumeClock(); };
  $('pf-close').addEventListener('click', close);
  o.onclick = (e) => { if (e.target === o) close(); };
  if (canShare) {
    const input = $('pf-amount');
    o.querySelectorAll('.pf-share .presets button').forEach((b) => b.addEventListener('click', () => {
      input.value = Math.max(1, Math.floor(myChips * Number(b.dataset.p) / 100));
    }));
    $('pf-send').addEventListener('click', () => {
      const amount = Math.floor(Number(input.value));
      try {
        const res = table.transfer(id, amount);
        if (table.mode === 'local') toast(t(res.queued ? 'toast.sentQueued' : 'toast.sent', { name: pr.name, amount: fmt(amount) }));
        close();
        if (table.mode === 'local' && lastSnap) { lastSnap = table.snap(); render(lastSnap); }
      } catch (e) { toast(errText(e)); }
    });
  }
  $('pf-cam')?.addEventListener('click', () => toggleMedia('cam'));
  $('pf-mic')?.addEventListener('click', () => toggleMedia('mic'));
  $('pf-mute')?.addEventListener('click', () => { media.setMuted(id, !media.muted.has(id)); openProfile(id); });
}

// ================= лобби =================
function langOptions(sel) {
  return LANGS.map((l) => `<option value="${l.code}" ${l.code === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
}

function showSetup(first = false) {
  const o = $('overlay');
  const s = settings;
  if (table) table.pauseClock();
  const tab = s.tab === 'online' ? 'online' : 'local';
  const seg = (id, values, current, label) => `<div class="seg" id="${id}">${values.map(([v, txt]) =>
    `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(current)}">${esc(txt ?? v)}</button>`).join('')}</div>`;
  const prefillId = (location.hash || '').replace('#', '').toUpperCase().slice(0, 6);
  o.innerHTML = `
  <form class="dialog setup" id="setup" novalidate>
    <div class="setup-head">
      <h1>Texas <span>Hold’em</span></h1>
      <select id="f-lang" class="lang-full" aria-label="${esc(t('app.language'))}">${langOptions(s.lang)}</select>
    </div>
    <div class="row2">
      <div class="field"><label for="f-name">${esc(t('setup.name'))}</label><input id="f-name" maxlength="14" value="${esc(s.name)}" autocomplete="nickname"></div>
    </div>
    <div class="field"><label>${esc(t('setup.avatar'))}</label><div class="ava-grid" id="f-ava">
      ${Array.from({ length: AVATAR_COUNT }, (_, i) => `h${i}`).map((id) =>
        `<button type="button" data-v="${id}" aria-pressed="${id === s.avatar}" aria-label="${esc(t('setup.avatar'))} ${id.slice(1)}">${avatarSVG(id)}</button>`).join('')}
    </div></div>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="local" aria-selected="${tab === 'local'}">${esc(t('setup.tabBots'))}</button>
      <button type="button" role="tab" data-tab="online" aria-selected="${tab === 'online'}">${esc(t('setup.tabOnline'))}</button>
    </div>
    <div class="tab-panel" data-panel="local" ${tab === 'local' ? '' : 'hidden'}>
      <p>${esc(t(first ? 'setup.botsIntro' : 'setup.restartNote'))}</p>
      <div class="field"><label>${esc(t('setup.opponents'))}</label>${seg('f-bots', [1, 2, 3, 4, 5].map((n) => [n]), s.bots)}</div>
      <div class="row2">
        <div class="field"><label for="f-blinds">${esc(t('setup.blinds'))}</label><select id="f-blinds">
          ${Object.keys(BLINDS).map((b) => `<option ${b === s.blinds ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
        <div class="field"><label for="f-stack">${esc(t('setup.stack'))}</label><select id="f-stack">
          ${STACKS.map((v) => `<option value="${v}" ${v === s.stack ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>${esc(t('setup.speed'))}</label>${seg('f-speed', [['slow', t('setup.slow')], ['normal', t('setup.normal')], ['fast', t('setup.fast')]], s.speed)}</div>
      <p class="note">${esc(t('setup.turnNote', { s: TURN_SECONDS }))}</p>
      <button class="btn primary wide" type="button" id="f-start">${esc(t(first ? 'setup.sit' : 'setup.restart'))}</button>
    </div>
    <div class="tab-panel" data-panel="online" ${tab === 'online' ? '' : 'hidden'}>
      <p>${esc(t('online.intro'))}</p>
      <div class="field"><label for="f-join-id">${esc(t('online.tableId'))}</label>
        <div class="pf-row"><input id="f-join-id" maxlength="6" placeholder="ABC123" value="${esc(prefillId)}" autocapitalize="characters" spellcheck="false">
        <button class="btn primary" type="button" id="f-join">${esc(t('online.join'))}</button></div></div>
      <div class="divider"></div>
      <div class="row2">
        <div class="field"><label for="f-oblinds">${esc(t('setup.blinds'))}</label><select id="f-oblinds">
          ${Object.keys(BLINDS).map((b) => `<option ${b === (s.onlineBlinds || s.blinds) ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
        <div class="field"><label for="f-ostack">${esc(t('setup.stack'))}</label><select id="f-ostack">
          ${STACKS.map((v) => `<option value="${v}" ${v === (s.onlineStack || s.stack) ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>${esc(t('online.fillBots'))}</label>${seg('f-obots', [0, 1, 2, 3, 4].map((n) => [n]), s.onlineBots)}</div>
      <button class="btn wide" type="button" id="f-create">${esc(t('online.create'))}</button>
      <details class="server-box"><summary>${esc(t('online.server'))}</summary>
        <input id="f-server" value="${esc(s.server)}" placeholder="P2P" spellcheck="false" aria-label="${esc(t('online.server'))}">
        <p class="note">${esc(t('online.serverHint'))}</p>
      </details>
      ${serverUrl() ? '' : `<p class="note">${esc(t('online.hostNote'))}</p>`}
      <p class="status" id="f-status" role="status"></p>
    </div>
    ${table ? `<div class="pf-row">${table.mode === 'online' ? `<button class="ghost" type="button" id="f-leave">${esc(t('app.leave'))}</button>` : ''}
      <button class="ghost" type="button" id="f-cancel">${esc(t('setup.back'))}</button></div>` : ''}
  </form>`;
  o.hidden = false;
  o.onclick = null;

  const segWire = (id, key, cast) => $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    s[key] = cast(b.dataset.v);
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  segWire('f-ava', 'avatar', String);
  segWire('f-bots', 'bots', Number);
  segWire('f-speed', 'speed', String);
  segWire('f-obots', 'onlineBots', Number);
  o.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => {
    s.tab = b.dataset.tab;
    o.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    o.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== s.tab; });
  }));
  $('f-lang').addEventListener('change', (e) => { readCommon(); changeLang(e.target.value); });
  const readCommon = () => {
    s.name = $('f-name').value.trim() || s.name;
    s.blinds = $('f-blinds').value;
    s.stack = +$('f-stack').value;
    s.onlineBlinds = $('f-oblinds').value;
    s.onlineStack = +$('f-ostack').value;
    s.server = $('f-server').value.trim();
    saveSettings();
  };
  const close = () => { o.hidden = true; o.innerHTML = ''; };
  $('f-start').addEventListener('click', () => { readCommon(); close(); startLocal(); });

  const online = async (kind) => {
    readCommon();
    const id = $('f-join-id').value.trim().toUpperCase();
    if (kind === 'join' && !/^[A-Z0-9]{6}$/.test(id)) { $('f-status').textContent = t('err.tableNotFound'); return; }
    $('f-status').textContent = t('online.connecting');
    o.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await startOnline(kind, id);
      close();
    } catch (e) {
      $('f-status').textContent = errText(e) + (e.code === 'connectFailed' && serverUrl() ? ' — ' + t('online.serverHint') : '');
      o.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };
  $('f-join').addEventListener('click', () => online('join'));
  $('f-create').addEventListener('click', () => online('create'));
  $('f-join-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); online('join'); } });
  $('f-cancel')?.addEventListener('click', () => { readCommon(); close(); table && table.resumeClock(); });
  $('f-leave')?.addEventListener('click', () => {
    teardown(); lastSnap = null; previewTable(); close(); showSetup(true);
    try { history.replaceState(null, '', location.pathname); } catch {}
  });
  $('setup').addEventListener('submit', (e) => e.preventDefault());
}

function showEnd(won, hands) {
  const o = $('overlay');
  o.innerHTML = `<div class="dialog">
    <h1>${esc(t(won ? 'end.won' : 'end.lost'))}</h1>
    <p>${esc(t(won ? 'end.wonText' : 'end.lostText', { n: hands }))}</p>
    <button class="btn primary wide" id="again">${esc(t('end.again'))}</button>
    <button class="ghost" id="change">${esc(t('end.settings'))}</button>
  </div>`;
  o.hidden = false;
  $('again').addEventListener('click', () => { o.hidden = true; startLocal(); });
  $('change').addEventListener('click', () => showSetup(false));
}

$('btn-lobby').addEventListener('click', () => showSetup(!table));
window.addEventListener('resize', () => { if (lastSnap) render(lastSnap); updateLogButton(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && profileOpenFor) $('pf-close')?.click();
});

// ================= старт =================
// Первый кадр: стол с игроками за окном лобби
function previewTable() {
  const seats = Array(6).fill(null);
  seats[0] = { seat: 0, id: 'preview-me', name: settings.name, chips: settings.stack, meta: { avatar: settings.avatar }, inHand: false };
  BOT_LAYOUT[settings.bots || 5].forEach((seat, i) => {
    seats[seat] = { seat, id: 'pv' + seat, name: BOT_NAMES[i], chips: settings.stack, isBot: true, meta: { avatar: BOT_NAMES[i] }, inHand: false };
  });
  render({ seats, board: [], pot: 0, buttonSeat: -1, toAct: -1, phase: PHASE.WAITING, handNumber: 0, config: { smallBlind: 10, bigBlind: 20 } });
  renderActions();
}

applyStaticTexts();
previewTable();
showSetup(true);
if (/^#[A-Z0-9]{6}$/i.test(location.hash || '')) {
  settings.tab = 'online';
  showSetup(true);
}

// Хост P2P-стола: закрытие вкладки закрывает стол для всех — спрашиваем подтверждение
window.addEventListener('beforeunload', (e) => { if (hosting) { e.preventDefault(); e.returnValue = ''; } });
