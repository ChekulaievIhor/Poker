// Статистика игроков в JSON-файле. Для продакшена заменить на базу данных (Postgres и т. п.).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

export class StatsStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* файла ещё нет */ }
    this.timer = null;
  }

  get(token) {
    return (this.data[token] ||= { name: '', hands: 0, wins: 0, biggest: 0 });
  }

  // Отложенная запись, чтобы не писать файл на каждую раздачу
  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000);
    this.timer.unref?.();
  }

  flush() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (e) { console.error('stats', e.message); }
  }
}
