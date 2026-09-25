// Authoritative in-memory room state. The server is the single source of
// truth for playback; clients never trust each other.
const rooms = new Map(); // code -> state

const DEMO = { type: 'demo', title: 'Big Buck Bunny (CC-BY)', url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_10s_1MB.mp4' };

function ensure(code, meta) {
  let r = rooms.get(code);
  if (!r) {
    r = {
      roomId: code, hostId: meta.hostId, name: meta.name,
      everyoneControls: !!meta.everyoneControls,
      chatEnabled: meta.chatEnabled !== false,
      callEnabled: meta.callEnabled !== false,
      maxParticipants: meta.maxParticipants || 2,
      participants: new Map(), // userId -> {id,name,avatar,sockets:Set,online}
      media: null,
      playback: { isPlaying: false, currentTime: 0, playbackRate: 1, updatedAt: Date.now() },
    };
    rooms.set(code, r);
  }
  return r;
}
const get = code => rooms.get(code) || null;

function canControl(room, userId) {
  return room.everyoneControls || room.hostId === userId;
}

// Project the stored playback position forward to "now".
function projected(room) {
  const p = room.playback;
  if (!p.isPlaying) return p.currentTime;
  return p.currentTime + ((Date.now() - p.updatedAt) / 1000) * p.playbackRate;
}

function applyPlayback(room, { action, currentTime, playbackRate }) {
  const p = room.playback;
  const t = Number.isFinite(currentTime) ? Math.max(0, currentTime) : projected(room);
  switch (action) {
    case 'PLAY':  p.isPlaying = true;  p.currentTime = t; break;
    case 'PAUSE': p.isPlaying = false; p.currentTime = t; break;
    case 'SEEK':  p.currentTime = t; break;
    case 'RATE':  p.currentTime = projected(room);
                  p.playbackRate = Math.min(4, Math.max(0.25, Number(playbackRate) || 1)); break;
    default: return null;
  }
  p.updatedAt = Date.now();
  return p;
}

function snapshot(room) {
  return {
    roomId: room.roomId, name: room.name, hostId: room.hostId,
    everyoneControls: room.everyoneControls,
    chatEnabled: room.chatEnabled, callEnabled: room.callEnabled,
    media: room.media,
    playback: { ...room.playback, currentTime: projected(room) },
    serverNow: Date.now(),
    participants: [...room.participants.values()].map(p =>
      ({ id: p.id, name: p.name, avatar: p.avatar, online: p.sockets.size > 0 })),
  };
}

function destroy(code) { rooms.delete(code); }

module.exports = { ensure, get, canControl, applyPlayback, snapshot, projected, destroy, DEMO, rooms };
