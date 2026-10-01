// Сетевая игра без своего сервера (подходит для Netlify и любого статического хостинга).
// Браузер того, кто создал стол, становится «сервером»: в нём работает тот же Hub, что и на Node.
// Остальные подключаются к нему напрямую по WebRTC; для знакомства браузеров используется
// бесплатный сигнальный сервер PeerJS (0.peerjs.com). ID стола = адрес хоста в PeerJS.
import { Peer } from 'peerjs';
import { Hub, randomTableId } from '../net/hub.js';
import { NetError } from './net-table.js';
import { ICE_SERVERS } from './ice.js';

const PREFIX = 'holdem-nl-v1-';
const PING = '__ping';
const PING_MS = 5000;
const DEAD_MS = 16000;

// Свой сигнальный сервер PeerJS можно указать через window.HOLDEM_PEER = { host, port, path, secure }
const PEER_OPTS = { config: { iceServers: ICE_SERVERS }, debug: 0, ...(globalThis.HOLDEM_PEER || {}) };

// Канал данных с «пингом»: если собеседник пропал без закрытия соединения, замечаем это за ~16 с
function keepAlive(dc, onDead) {
  let last = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - last > DEAD_MS) { clearInterval(timer); onDead(); return; }
    try { dc.send(PING); } catch {}
  }, PING_MS);
  return { seen() { last = Date.now(); }, stop() { clearInterval(timer); } };
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer); peer.off('open', ok);
      try { peer.destroy(); } catch {}
      reject(e);
    };
    const ok = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); peer.off('error', fail);
      resolve(peer);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { type: 'network' })), 12000);
    peer.once('open', ok);
    peer.once('error', fail);
  });
}

/** Хост: регистрирует ID стола в PeerJS и принимает подключения игроков. */
export async function startHost() {
  let peer, id;
  for (let attempt = 0; attempt < 5 && !peer; attempt++) {
    id = randomTableId();
    try { peer = await openPeer(PREFIX + id); }
    catch (e) { if (e.type !== 'unavailable-id') throw new NetError('connectFailed'); }
  }
  if (!peer) throw new NetError('connectFailed');

  const hub = new Hub({ fixedTableId: id });
  peer.on('connection', (dc) => {
    dc.on('open', () => {
      const conn = hub.connect({ send: (s) => dc.send(s), close: () => dc.close() });
      let gone = false;
      const done = () => { if (gone) return; gone = true; ka.stop(); conn.closed(); };
      const ka = keepAlive(dc, () => { done(); try { dc.close(); } catch {} });
      dc.on('data', (d) => { ka.seen(); if (d !== PING) conn.receive(String(d)); });
      dc.on('close', done);
      dc.on('error', done);
    });
  });
  // Потеря связи с сигнальным сервером не рвёт уже открытые соединения; восстанавливаем для новых игроков
  peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch {} }, 1500); });

  return {
    id,
    hub,
    // Клиент самого хоста подключается к своему Hub напрямую, без сети
    loopback() {
      const t = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
      const conn = hub.connect({ send: (s) => setTimeout(() => t.onmessage && t.onmessage({ data: s }), 0), close() {} });
      t.send = (s) => setTimeout(() => conn.receive(s), 0);
      t.close = () => { t.readyState = 3; conn.closed(); };
      setTimeout(() => { t.readyState = 1; t.onopen && t.onopen(); }, 0);
      return t;
    },
    destroy() { hub.destroy(); try { peer.destroy(); } catch {} },
  };
}

/** Гость: подключается к хосту стола по ID. Объект ведёт себя как WebSocket. */
export function guestTransport(tableId) {
  const t = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
  let peer = null, dc = null, ka = null, closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    const wasOpen = t.readyState === 1;
    t.readyState = 3;
    if (ka) ka.stop();
    try { peer && peer.destroy(); } catch {}
    if (wasOpen) t.onclose && t.onclose();
  };
  const fail = (code) => { if (t.readyState === 0) t.onerror && t.onerror({ code }); finish(); };

  openPeer(null).then((p) => {
    peer = p;
    if (closed) { p.destroy(); return; }
    // Хоста нет в сети → такого стола нет
    p.on('error', (e) => fail(e.type === 'peer-unavailable' ? 'tableNotFound' : 'connectFailed'));
    dc = p.connect(PREFIX + String(tableId).toUpperCase(), { reliable: true, serialization: 'raw' });
    dc.on('open', () => {
      t.readyState = 1;
      ka = keepAlive(dc, () => finish());
      t.onopen && t.onopen();
    });
    dc.on('data', (d) => { ka && ka.seen(); if (d !== PING) t.onmessage && t.onmessage({ data: String(d) }); });
    dc.on('close', finish);
    dc.on('error', () => fail('connectFailed'));
    setTimeout(() => { if (t.readyState === 0) fail('tableNotFound'); }, 15000);
  }, () => fail('connectFailed'));

  t.send = (s) => { if (dc && t.readyState === 1) dc.send(s); };
  t.close = finish;
  return t;
}
