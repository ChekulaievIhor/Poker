// Камера и микрофон: WebRTC «каждый с каждым», сигналинг через игровой сервер.
// Видео идёт браузер-браузер напрямую, сервер видит только служебные сообщения.
import { Emitter } from './emitter.js';
import { ICE_SERVERS as ICE } from './ice.js';

class Peer {
  constructor(id, polite, signal, onTrack) {
    this.id = id;
    this.polite = polite;
    this.signal = signal;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.senders = { audio: null, video: null };
    this.stream = new MediaStream();
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription });
      } catch (e) { console.warn('negotiation', e); } finally { this.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal({ candidate }); };
    pc.ontrack = ({ track }) => {
      for (const t of this.stream.getTracks()) if (t.kind === track.kind && t !== track) this.stream.removeTrack(t);
      this.stream.addTrack(track);
      track.onunmute = () => onTrack(this.id);
      onTrack(this.id);
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  }

  // «Вежливые» переговоры (perfect negotiation): обе стороны могут начинать без конфликтов
  async handle({ description, candidate }) {
    const pc = this.pc;
    try {
      if (description) {
        const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          this.signal({ description: pc.localDescription });
        }
      } else if (candidate) {
        try { await pc.addIceCandidate(candidate); } catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('rtc', e); }
  }

  setTrack(kind, track, stream) {
    if (this.senders[kind]) this.senders[kind].replaceTrack(track);
    else if (track) this.senders[kind] = this.pc.addTrack(track, stream);
  }

  close() { try { this.pc.close(); } catch {} }
}

export class Media extends Emitter {
  constructor(net) {
    super();
    this.net = net;
    this.local = new MediaStream();
    this.cam = false;
    this.mic = false;
    this.peers = new Map();
    this.videos = new Map();   // id -> <video>, переиспользуются между перерисовками
    this.audios = new Map();   // id -> <audio>
    this.muted = new Set();    // кого я заглушил у себя
    this.sink = document.createElement('div');
    this.sink.hidden = true;
    document.body.appendChild(this.sink);
    net.on('rtc', (from, data) => this.peerFor(from).handle(data));
  }

  static supported() {
    return !!(globalThis.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  static secure() { return globalThis.isSecureContext !== false; }

  peerFor(id) {
    let p = this.peers.get(id);
    if (!p) {
      p = new Peer(id, this.net.myId > id, (data) => this.net.rtc(id, data), (pid) => this.attachRemote(pid));
      for (const t of this.local.getTracks()) p.setTrack(t.kind, t, this.local);
      this.peers.set(id, p);
    }
    return p;
  }

  // Синхронизировать список соединений с людьми за столом
  sync(humanIds) {
    const want = new Set(humanIds.filter((id) => id !== this.net.myId));
    for (const id of want) this.peerFor(id);
    for (const [id, p] of this.peers) {
      if (!want.has(id)) {
        p.close();
        this.peers.delete(id);
        this.videos.get(id)?.remove(); this.videos.delete(id);
        this.audios.get(id)?.remove(); this.audios.delete(id);
      }
    }
  }

  attachRemote(id) {
    const p = this.peers.get(id);
    if (!p) return;
    const a = this.audioEl(id);
    if (a.srcObject !== p.stream) a.srcObject = p.stream;
    a.play().catch(() => {});
    const v = this.videoEl(id);
    if (v.srcObject !== p.stream) v.srcObject = p.stream;
    this.emit('change', id);
  }

  audioEl(id) {
    let a = this.audios.get(id);
    if (!a) {
      a = document.createElement('audio');
      a.autoplay = true;
      a.muted = this.muted.has(id);
      this.sink.appendChild(a);
      this.audios.set(id, a);
    }
    return a;
  }

  /** <video> игрока (своего — превью). Звук всегда из отдельного <audio>, сам видео-элемент без звука. */
  videoEl(id) {
    let v = this.videos.get(id);
    if (!v) {
      v = document.createElement('video');
      v.autoplay = true;
      v.playsInline = true;
      v.muted = true;
      v.className = 'cam';
      if (id === this.net.myId) { v.srcObject = this.local; v.classList.add('self'); }
      this.videos.set(id, v);
    }
    return v;
  }

  hasVideo(id) {
    if (id === this.net.myId) return this.cam;
    const p = this.peers.get(id);
    return !!p && p.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  async setCam(on) { return this.setKind('video', on); }
  async setMic(on) { return this.setKind('audio', on); }

  async setKind(kind, on) {
    const old = this.local.getTracks().find((t) => t.kind === kind);
    if (on && !old) {
      const constraints = kind === 'video'
        ? { video: { width: { ideal: 480 }, height: { ideal: 480 }, facingMode: 'user' } }
        : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getTracks()[0];
      this.local.addTrack(track);
      for (const p of this.peers.values()) p.setTrack(kind, track, this.local);
    } else if (!on && old) {
      old.stop();
      this.local.removeTrack(old);
      for (const p of this.peers.values()) p.setTrack(kind, null, this.local);
    }
    if (kind === 'video') this.cam = on; else this.mic = on;
    const self = this.videoEl(this.net.myId);
    self.srcObject = this.local;
    self.play().catch(() => {});
    this.net.setMedia(this.cam, this.mic);
    this.emit('change', this.net.myId);
  }

  setMuted(id, muted) {
    if (muted) this.muted.add(id); else this.muted.delete(id);
    const a = this.audios.get(id);
    if (a) a.muted = muted;
  }

  destroy() {
    for (const t of this.local.getTracks()) t.stop();
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    for (const v of this.videos.values()) v.remove();
    this.sink.remove();
  }
}
