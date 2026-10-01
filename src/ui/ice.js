// STUN/TURN для WebRTC (видео, звук и P2P-столы). TURN нужен, когда прямое соединение невозможно
// (строгий NAT, мобильные сети). Сейчас — публичные серверы PeerJS; для продакшена поставить свой coturn.
export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];
