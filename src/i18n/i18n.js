// Локализация: 35 европейских языков + арабский (RTL).
// Добавить язык: положить словарь в locales/<код>.js и строку в LANGS.
import en from './locales/en.js';
import ru from './locales/ru.js';
import uk from './locales/uk.js';
import be from './locales/be.js';
import de from './locales/de.js';
import fr from './locales/fr.js';
import es from './locales/es.js';
import ca from './locales/ca.js';
import pt from './locales/pt.js';
import it from './locales/it.js';
import nl from './locales/nl.js';
import pl from './locales/pl.js';
import cs from './locales/cs.js';
import sk from './locales/sk.js';
import sl from './locales/sl.js';
import hr from './locales/hr.js';
import bs from './locales/bs.js';
import sr from './locales/sr.js';
import mk from './locales/mk.js';
import bg from './locales/bg.js';
import ro from './locales/ro.js';
import hu from './locales/hu.js';
import el from './locales/el.js';
import sq from './locales/sq.js';
import tr from './locales/tr.js';
import sv from './locales/sv.js';
import nb from './locales/nb.js';
import da from './locales/da.js';
import fi from './locales/fi.js';
import is from './locales/is.js';
import et from './locales/et.js';
import lv from './locales/lv.js';
import lt from './locales/lt.js';
import ga from './locales/ga.js';
import mt from './locales/mt.js';
import ar from './locales/ar.js';

export const DICTS = { en, ru, uk, be, de, fr, es, ca, pt, it, nl, pl, cs, sk, sl, hr, bs, sr, mk, bg, ro, hu, el, sq, tr, sv, nb, da, fi, is, et, lv, lt, ga, mt, ar };

export const LANGS = [
  ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['ca', 'Català'],
  ['pt', 'Português'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['uk', 'Українська'],
  ['ru', 'Русский'], ['be', 'Беларуская'], ['cs', 'Čeština'], ['sk', 'Slovenčina'], ['sl', 'Slovenščina'],
  ['hr', 'Hrvatski'], ['bs', 'Bosanski'], ['sr', 'Српски'], ['mk', 'Македонски'], ['bg', 'Български'],
  ['ro', 'Română'], ['hu', 'Magyar'], ['el', 'Ελληνικά'], ['sq', 'Shqip'], ['tr', 'Türkçe'],
  ['sv', 'Svenska'], ['nb', 'Norsk'], ['da', 'Dansk'], ['fi', 'Suomi'], ['is', 'Íslenska'],
  ['et', 'Eesti'], ['lv', 'Latviešu'], ['lt', 'Lietuvių'], ['ga', 'Gaeilge'], ['mt', 'Malti'],
  ['ar', 'العربية'],
].map(([code, name]) => ({ code, name, dir: code === 'ar' ? 'rtl' : 'ltr' }));

let current = 'en';
let dict = en;
let numFmt = new Intl.NumberFormat('en');

export function detectLang() {
  const prefs = (globalThis.navigator && navigator.languages) || ['en'];
  for (const p of prefs) {
    const base = String(p).toLowerCase().split('-')[0];
    const code = base === 'no' || base === 'nn' ? 'nb' : base;
    if (DICTS[code]) return code;
  }
  return 'en';
}

export function setLang(code) {
  if (!DICTS[code]) code = 'en';
  current = code;
  dict = DICTS[code];
  // Арабский — с латинскими цифрами: суммы фишек читаются привычно и совпадают с полем ввода
  numFmt = new Intl.NumberFormat(code === 'ar' ? 'ar-u-nu-latn' : code);
  if (globalThis.document) {
    document.documentElement.lang = code;
    document.documentElement.dir = code === 'ar' ? 'rtl' : 'ltr';
  }
  return code;
}

export const lang = () => current;

/** Перевод с подстановкой {параметров}. Нет ключа в языке — берём английский. */
export function t(key, params = {}) {
  const s = dict[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** То же, но для вставки в innerHTML: параметры экранируются, кроме тех, чьё имя заканчивается на Html. */
export function th(key, params = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.endsWith('Html')) safe[k.slice(0, -4)] = v; // уже готовый HTML (например, сумма в <span>)
    else safe[k] = `<bdi>${esc(v)}</bdi>`; // bdi — имена на латинице не ломают арабскую строку
  }
  return t(key, safe);
}

export function fmt(n) { return numFmt.format(n); }

/** Название комбинации из результата evaluate(): { key, ranks } */
export function handName(ev) {
  if (!ev || !ev.key) return '';
  const r = (v) => (v === '10' ? '10' : v);
  return t('hand.' + ev.key, { a: r(ev.ranks[0]), b: r(ev.ranks[1]) });
}
