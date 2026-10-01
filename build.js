// Сборка в один самодостаточный HTML: dist/index.html (открывается двойным кликом)
// и .artifact/artifact.html (фрагмент без <html>/<body> для публикации на claude.ai).
// Папку dist целиком можно выложить на Netlify — это готовый сайт из одного файла.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const js = (await build({
  entryPoints: ['src/ui/app.js'],
  bundle: true, format: 'iife', minify: true, write: false, target: 'es2020',
})).outputFiles[0].text;
const css = readFileSync('src/ui/style.css', 'utf8');

const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800&family=Bodoni+Moda:wght@700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;600&display=swap">';

const fragment = `<title>Hold'em NL</title>
<!--HOLDEM_SERVER-->
${fonts}
<style>${css}</style>
<div id="app"></div>
<script>${js.replace(/<\/script/g, '<\\/script')}</script>
`;

mkdirSync('dist', { recursive: true });
mkdirSync('.artifact', { recursive: true });
writeFileSync('.artifact/artifact.html', fragment); // версия для claude.ai (без <html>/<body>)
writeFileSync('dist/index.html', `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${fragment.replace('<div id="app"></div>', '</head><body><div id="app"></div>')}
</body></html>
`);
console.log('dist/index.html', (fragment.length / 1024).toFixed(1) + ' KB');
