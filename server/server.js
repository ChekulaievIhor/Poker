// Игровой сервер на Node.js: столы по ID, авторитетный движок, таймер хода, боты, статистика,
// передача фишек и ретрансляция WebRTC-сигналов. Вся логика стола — в src/net/hub.js.
// Нужен, если хостинг поддерживает долгоживущие процессы (Render, Railway, Fly, VPS).
// Для Netlify сервер не нужен: там сетевая игра идёт напрямую между браузерами (см. src/ui/p2p.js).
// Запуск: npm start  (PORT=8080 по умолчанию). Раздаёт и клиент: dist/index.html.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Hub } from '../src/net/hub.js';
import { StatsStore } from './stats.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;

const hub = new Hub({
  stats: new StatsStore(process.env.STATS_FILE || path.join(ROOT, 'server', 'data', 'stats.json')),
  turnMs: Number(process.env.TURN_MS) || 30_000,
  nextHandMs: Number(process.env.NEXT_HAND_MS) || 4500,
  botDelay: [Number(process.env.BOT_MIN_MS) || 1200, Number(process.env.BOT_MAX_MS) || 2600],
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(ROOT, 'dist', 'index.html');
    if (!existsSync(file)) { res.writeHead(500); return res.end('Run "npm run build" first'); }
    // Метка для клиента: страница отдана нашим сервером — играть через WebSocket этого же адреса
    const html = readFileSync(file, 'utf8').replace('<!--HOLDEM_SERVER-->', '<script>window.HOLDEM_WS=true</script>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(html);
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  const conn = hub.connect({ send: (s) => { if (ws.readyState === 1) ws.send(s); }, close: () => ws.close(4000, 'replaced') });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => conn.receive(String(data)));
  ws.on('close', () => conn.closed());
});

// Пинг для обнаружения оборванных соединений
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000).unref();

server.listen(PORT, () => {
  console.log(`Hold'em server: http://localhost:${PORT}`);
});

export { server, hub };
