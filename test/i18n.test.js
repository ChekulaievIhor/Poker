// Проверка словарей: в каждом языке те же ключи, что в английском, и те же {параметры}.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DICTS, LANGS, t, setLang, handName } from '../src/i18n/i18n.js';

const en = DICTS.en;
const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
let problems = 0;

assert.equal(LANGS.length, Object.keys(DICTS).length, 'LANGS и DICTS совпадают');
for (const { code } of LANGS) {
  const d = DICTS[code];
  for (const k of Object.keys(en)) {
    if (!(k in d)) { console.log(`✗ ${code}: нет ключа ${k}`); problems++; continue; }
    if (params(d[k]) !== params(en[k])) { console.log(`✗ ${code}: ${k} параметры «${d[k]}»`); problems++; }
    if (!String(d[k]).trim()) { console.log(`✗ ${code}: ${k} пусто`); problems++; }
  }
  for (const k of Object.keys(d)) if (!(k in en)) { console.log(`✗ ${code}: лишний ключ ${k}`); problems++; }
}

// Каждый t('...') в клиенте должен существовать в en
const used = new Set();
for (const f of ['src/ui/app.js', 'src/ui/net-table.js', 'src/ui/local-table.js', 'src/ui/media.js']) {
  let src = '';
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/\bt[h]?\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) used.add(m[1]);
}
for (const k of used) if (!(k in en)) { console.log(`✗ в коде используется неизвестный ключ ${k}`); problems++; }

setLang('ru');
assert.equal(t('log.wins', { name: 'Аня', amount: 50 }), 'Аня забирает 50');
assert.equal(handName({ key: 'twoPair', ranks: ['A', 'K'] }), 'Две пары: A и K');
setLang('ar');
assert.equal(globalThis.document, undefined);
setLang('en');

assert.equal(problems, 0, `проблем в словарях: ${problems}`);
console.log(`✓ i18n: ${LANGS.length} языков × ${Object.keys(en).length} строк, ключей в коде: ${used.size}`);
void readdirSync;
