export class Emitter {
  constructor() { this._h = {}; }
  on(name, fn) { (this._h[name] ||= []).push(fn); return this; }
  emit(name, ...args) { for (const fn of this._h[name] || []) fn(...args); }
}
