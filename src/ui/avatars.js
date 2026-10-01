// Процедурные аватарки: детерминированный SVG-портрет из строки-сида.
// Без внешних картинок — сервер позже сможет хранить просто сид, а не файл.

const BG = ['#2f5d62', '#5e3a5c', '#8a6a2e', '#3d4a66', '#7a3b2e', '#4f5d2f', '#2d4f45', '#6a4a3a'];
const SKIN = ['#f1d3bc', '#e8b893', '#c98e64', '#a86b45', '#7c4a2d', '#5b3620'];
const HAIR = ['#1d1612', '#3b2516', '#6b4226', '#b8863b', '#9c4a24', '#8d8d8d', '#d9cfc0'];
const SHIRT = ['#1f2a33', '#5a1f1a', '#26443b', '#3a3150', '#6b5428', '#2b2b2b', '#cfc6b4'];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = hash(String(seed)) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const HAIR_STYLES = {
  bald: () => '',
  short: (c) => `<path d="M17 32C17 20 24 16 32 16S47 20 47 32C44 26 38 23 32 23S20 26 17 32Z" fill="${c}"/>`,
  side: (c) => `<path d="M17 33C16 20 24 15 33 15C42 15 48 21 47 31C41 24 30 22 22 26L19 34Z" fill="${c}"/>`,
  long: (c) => `<path d="M16 35C15 20 23 15 32 15S49 20 48 35L49 50C46 48 45 42 45 35C42 27 22 27 19 35C19 42 18 47 15 50Z" fill="${c}"/>`,
  bun: (c) => `<circle cx="32" cy="13" r="6" fill="${c}"/><path d="M17 32C17 20 24 17 32 17S47 20 47 32C44 26 38 24 32 24S20 26 17 32Z" fill="${c}"/>`,
  curly: (c) => [[19, 28], [23, 21], [30, 18], [37, 18], [43, 22], [46, 29]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="${c}"/>`).join(''),
  mohawk: (c) => `<path d="M28 13Q32 9 36 13L35 27H29Z" fill="${c}"/>`,
};
const HATS = {
  none: () => '',
  cap: (c) => `<path d="M17 28C17 19 24 15 32 15S47 19 47 28Z" fill="${c}"/><path d="M30 26H53Q53 30 47 30H30Z" fill="${c}" opacity=".85"/>`,
  fedora: (c) => `<path d="M12 27Q32 21 52 27Q46 30 32 29Q18 30 12 27Z" fill="${c}"/><path d="M20 26Q20 14 32 14Q44 14 44 26Z" fill="${c}"/><path d="M20 23H44V26H20Z" fill="#000" opacity=".35"/>`,
  visor: () => `<path d="M16 27Q32 19 48 27L46 30Q32 25 18 30Z" fill="#2f6b4f"/>`,
};

export const AVATAR_COUNT = 12;

/** SVG-строка аватарки. seed — любая строка/число. */
export function avatarSVG(seed) {
  const r = rng(seed);
  const bg = pick(r, BG);
  const skin = pick(r, SKIN);
  const hair = pick(r, HAIR);
  const shirt = pick(r, SHIRT);
  const hairStyle = pick(r, Object.keys(HAIR_STYLES));
  const hatRoll = r();
  const hat = hatRoll < 0.62 ? 'none' : hatRoll < 0.76 ? 'cap' : hatRoll < 0.9 ? 'fedora' : 'visor';
  const eyesRoll = r();
  const mouth = pick(r, ['smile', 'flat', 'smirk', 'o']);
  const beard = r() < 0.25;
  const brows = r() < 0.5;

  let eyes;
  if (eyesRoll < 0.15) {
    eyes = `<rect x="21" y="31" width="9" height="5" rx="2" fill="#111"/><rect x="34" y="31" width="9" height="5" rx="2" fill="#111"/><path d="M30 33H34" stroke="#111" stroke-width="1.4"/>`;
  } else if (eyesRoll < 0.3) {
    eyes = `<circle cx="26" cy="34" r="1.8" fill="#1b1b1b"/><circle cx="38" cy="34" r="1.8" fill="#1b1b1b"/>
      <circle cx="26" cy="34" r="4.3" fill="none" stroke="#1b1b1b" stroke-width="1.3"/><circle cx="38" cy="34" r="4.3" fill="none" stroke="#1b1b1b" stroke-width="1.3"/><path d="M30.3 34H33.7" stroke="#1b1b1b" stroke-width="1.3"/>`;
  } else if (eyesRoll < 0.42) {
    eyes = `<path d="M23.5 34.5Q26 32.5 28.5 34.5M35.5 34.5Q38 32.5 40.5 34.5" stroke="#1b1b1b" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
  } else {
    eyes = `<circle cx="26" cy="34" r="1.9" fill="#1b1b1b"/><circle cx="38" cy="34" r="1.9" fill="#1b1b1b"/>`;
  }
  const browSvg = brows ? `<path d="M23 29.5L29 28.5M35 28.5L41 29.5" stroke="${hair}" stroke-width="1.6" stroke-linecap="round"/>` : '';
  const mouthSvg = {
    smile: `<path d="M28 41Q32 44.5 36 41" stroke="#4a2a20" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
    flat: `<path d="M28.5 42H35.5" stroke="#4a2a20" stroke-width="1.6" stroke-linecap="round"/>`,
    smirk: `<path d="M28 42Q33 43.5 36.5 40" stroke="#4a2a20" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
    o: `<ellipse cx="32" cy="42" rx="1.8" ry="2.2" fill="#4a2a20"/>`,
  }[mouth];
  const beardSvg = beard
    ? `<path d="M18 36C19 46 25 51 32 51S45 46 46 36C43 42 38 45 32 45S21 42 18 36Z" fill="${hair}"/>${mouthSvg}` : mouthSvg;

  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<rect width="64" height="64" fill="${bg}"/>
<path d="M8 66C10 52 20 47 32 47S54 52 56 66Z" fill="${shirt}"/>
<rect x="28" y="42" width="8" height="8" fill="${skin}"/>
<circle cx="32" cy="33" r="15" fill="${skin}"/>
<circle cx="17.5" cy="35" r="2.6" fill="${skin}"/><circle cx="46.5" cy="35" r="2.6" fill="${skin}"/>
${hat === 'none' || hairStyle === 'long' ? HAIR_STYLES[hairStyle](hair) : ''}
${HATS[hat](pick(r, SHIRT))}
${browSvg}${eyes}${beardSvg}
</svg>`;
}
