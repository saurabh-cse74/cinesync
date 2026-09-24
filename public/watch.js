const $ = id => document.getElementById(id);
const ROOM = location.pathname.split('/').pop().toUpperCase();
const v = $('main');
const remotes = $('remotes');
let me, state = null, applyingRemote = false, rateFix = null, iceCfg = { iceServers: [] };
const peerConnections = {};
const peerStreams = {};

const fmt = s => { s = Math.max(0, s | 0); const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, x = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };

(async () => {
  me = (await (await fetch('/api/me')).json()).user;
  if (!me) return location.href = '/';
  iceCfg = await (await fetch('/api/config/ice')).json();
  connect();
})();

// ---------------------------------------------------------------- socket
const socket = io({ autoConnect: false });
function connect() {
  socket.connect();
  socket.on('connect', () => {
    net.className = 'pill ok'; net.textContent = '🟢 Connected';
    socket.emit('room:join', { roomCode: ROOM }, res => {
      if (res.error) { alert(res.error); return location.href = '/dashboard'; }
      onState(res.state);
    });
  });
  socket.on('disconnect', () => { net.className = 'pill bad'; net.textContent = '🔴 Reconnecting…'; });
  socket.io.on('reconnect_attempt', () => { net.className = 'pill warn'; net.textContent = '🟡 Reconnecting…'; });
  socket.on('room:state', onState);
  socket.on('PLAYBACK_UPDATE', p => { if (p.by !== me.id) apply(p); });
  socket.on('room:error', m => sysMsg(m));
  socket.on('chat:message', renderMsg);
  socket.on('reaction', ({ emoji }) => floatEmoji(emoji));
  socket.on('peer:joined', ({ userId }) => {
    if (!userId || userId === me.id) return;
    const peerPc = ensurePeerConnection(userId);
    if (local) addLocalTracks(peerPc);
    makeOffer(userId);
  });
  socket.on('peer:left', ({ userId }) => { if (userId) endCall(userId); });
  socket.on('webrtc:offer', ({ from, data }) => onOffer(from, data));
  socket.on('webrtc:answer', ({ from, data }) => peerConnections[from]?.setRemoteDescription(data));
  socket.on('webrtc:ice', ({ from, data }) => peerConnections[from]?.addIceCandidate(data).catch(() => {}));
  socket.on('webrtc:hangup', ({ from }) => { if (from) endCall(from); });
}

function onState(s) {
  state = s;
  rname.textContent = s.name + ' · ' + s.roomId;
  const others = s.participants.filter(p => p.id !== me.id);
  people.innerHTML = s.participants.map(p => `${p.online ? '🟢' : '⚪'} ${p.name}${p.id === s.hostId ? ' <span class="dim">(host)</span>' : ''}`).join('<br>');
  wait.textContent = others.length ? '' : 'Waiting for your friend… share the invite link.';
  if (s.hostId === me.id) { hostctl.style.display = 'block'; everyone.checked = s.everyoneControls; }
  if (s.media) { source.style.display = 'none'; loadMedia(s.media); }
  const activePeers = new Set(others.map(p => p.id));
  Object.keys(peerConnections).forEach(id => { if (!activePeers.has(id)) endCall(id); });
  apply(s.playback);
}
everyone.onchange = () => socket.emit('room:settings', { everyoneControls: everyone.checked });
const canControl = () => state && (state.everyoneControls || state.hostId === me.id);

// ------------------------------------------------- synchronization engine
function apply(p) {
  if (!p || !v.src && !v.currentSrc) { state && (state.playback = p); return; }
  applyingRemote = true;
  if (v.playbackRate !== p.playbackRate) v.playbackRate = p.playbackRate;
  const target = p.currentTime;
  const diff = Math.abs(v.currentTime - target);
  if (diff >= 1.5) { v.currentTime = target; setSync('SYNCING…', 'warn'); }      // hard correction
  else if (diff >= 0.25) nudge(target);                                          // soft rate correction
  if (p.isPlaying && v.paused) v.play().catch(() => {});
  if (!p.isPlaying && !v.paused) v.pause();
  state && (state.playback = p);
  setTimeout(() => { applyingRemote = false; }, 120);
  if (diff < 0.25) setSync('SYNCED ✓', 'ok');
}

// Gently speed up / slow down instead of seeking, to avoid visible jitter.
function nudge(target) {
  clearTimeout(rateFix);
  const base = state.playback.playbackRate;
  v.playbackRate = base * (v.currentTime < target ? 1.05 : 0.95);
  setSync('SYNCING…', 'warn');
  rateFix = setTimeout(() => { v.playbackRate = base; setSync('SYNCED ✓', 'ok'); }, 1800);
}
const setSync = (t, c) => { sync.textContent = t; sync.className = 'pill ' + c; };

// Drift watchdog: re-fetch authoritative state periodically and on tab focus.
setInterval(() => socket.connected && socket.emit('sync:request', s => { if (s) { state = s; apply(s.playback); } }), 5000);
document.addEventListener('visibilitychange', () => !document.hidden &&
  socket.emit('sync:request', s => s && apply(s.playback)));

// Local user intent -> server. Echo suppressed via `applyingRemote`.
function send(action, extra = {}) {
  if (applyingRemote) return;
  if (!canControl()) { sysMsg('Only the host can control playback in this room.'); return apply(state.playback); }
  socket.emit('playback:control', { action, currentTime: v.currentTime, ...extra });
}
v.addEventListener('play', () => send('PLAY'));
v.addEventListener('pause', () => send('PAUSE'));
v.addEventListener('seeked', () => send('SEEK'));
$('rate').onchange = e => { v.playbackRate = +e.target.value; send('RATE', { playbackRate: +e.target.value }); };

// ------------------------------------------------------------ player UI
$('pp').onclick = () => v.paused ? v.play() : v.pause();
v.addEventListener('timeupdate', () => {
  fill.style.width = (v.currentTime / (v.duration || 1) * 100) + '%';
  time.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration || 0)}`;
  $('pp').textContent = v.paused ? '▶' : '❚❚';
});
bar.onclick = e => { const r = bar.getBoundingClientRect(); v.currentTime = (e.clientX - r.left) / r.width * (v.duration || 0); };
$('mute').onclick = () => { v.muted = !v.muted; $('mute').textContent = v.muted ? '🔇' : '🔊'; };
$('fs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('pane-movie').requestFullscreen();
$('pipbtn').onclick = () => v.requestPictureInPicture?.().catch(() => {});
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  if (e.key === 'ArrowRight') v.currentTime += 5;
  if (e.key === 'ArrowLeft') v.currentTime -= 5;
  if (e.key.toLowerCase() === 'm') $('mute').click();
  if (e.key.toLowerCase() === 'f') $('fs').click();
});

// --------------------------------------------------------- media sources
function loadMedia(m) {
  if (m.type === 'youtube') { ytwrap.style.display = 'block'; v.style.display = 'none';
    ytwrap.innerHTML = `<iframe width="100%" height="100%" style="border:0" allow="autoplay; encrypted-media"
      src="https://www.youtube.com/embed/${encodeURIComponent(m.url)}?enablejsapi=1"></iframe>`;
    return sysMsg('YouTube source loaded (official embed; sync is best-effort).'); }
  if (v.dataset.url === m.url) return;
  v.dataset.url = m.url; v.src = m.url; v.load();
}
function setMedia(m) { socket.emit('media:change', m); source.style.display = 'none'; }
async function demo() { setMedia(await (await fetch('/api/demo')).json()); }
async function useUrl() {
  serr.textContent = '';
  const r = await fetch('/api/media/validate-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u.value }) });
  const d = await r.json();
  if (!r.ok) return serr.textContent = d.error;
  setMedia(d);
}
file.onchange = () => {
  const f = file.files[0]; if (!f) return;
  const fd = new FormData(); fd.append('video', f);
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = e => prog.textContent = `Uploading… ${(e.loaded / e.total * 100) | 0}%`;
  xhr.onload = () => { const d = JSON.parse(xhr.responseText || '{}');
    if (xhr.status !== 200) return serr.textContent = d.error || 'Upload failed. Please check your connection and try again.';
    prog.textContent = 'Video uploaded successfully.'; setMedia(d); };
  xhr.onerror = () => serr.textContent = 'Upload failed. Please check your connection and try again.';
  xhr.open('POST', '/api/upload'); xhr.send(fd);
};
async function shareScreen() {
  try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    v.srcObject = s; v.play(); source.style.display = 'none';
    sysMsg('Screen sharing locally — your friend sees it through the call stream.');
    Object.values(peerConnections).forEach(pc => s.getTracks().forEach(t => {
      if (!pc.getSenders().some(sender => sender.track === t)) pc.addTrack(t, s);
    }));
  } catch { serr.textContent = 'Screen share was not permitted.'; }
}

// -------------------------------------------------------------- chat
function renderMsg(m) {
  const d = document.createElement('div');
  d.className = 'msg ' + (m.system ? 'sys' : m.userId === me.id ? 'me' : '');
  d.innerHTML = m.system ? m.text : `<b>${m.name} · ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>${m.text}`;
  chatlog.append(d); chatlog.scrollTop = chatlog.scrollHeight;
}
const sysMsg = t => renderMsg({ system: true, text: t });
$('send').onclick = () => { if (msg.value.trim()) { socket.emit('chat:send', msg.value); msg.value = ''; } };
msg.onkeydown = e => e.key === 'Enter' && $('send').click();
emojis.innerHTML = ['❤️', '😂', '😮', '😭', '🔥', '👍'].map(e => `<button class="ico" onclick="socket.emit('reaction','${e}')">${e}</button>`).join('');
function floatEmoji(e) {
  const s = document.createElement('div'); s.className = 'float'; s.textContent = e;
  s.style.left = (10 + Math.random() * 75) + '%'; reactions.append(s); setTimeout(() => s.remove(), 2400);
}

// ------------------------------------------------------------- WebRTC
let local = null;

function renderRemoteTiles() {
  const ids = Object.keys(peerStreams);
  const primaryId = ids[0];
  const primary = primaryId ? peerStreams[primaryId] : null;
  if (primary) {
    $('remote').srcObject = primary;
    pip.style.display = 'block';
    const peer = (state?.participants || []).find(p => p.id === primaryId);
    peername.textContent = peer?.name || 'Friend';
  } else {
    $('remote').srcObject = null;
    pip.style.display = 'none';
    peername.textContent = 'Friend';
  }

  const extras = ids.filter(id => id !== primaryId);
  remotes.innerHTML = extras.map(id => {
    const peer = (state?.participants || []).find(p => p.id === id);
    return `<div class="remote-tile"><video autoplay playsinline data-remote-id="${id}"></video><span class="lbl">${peer?.name || 'Friend'}</span></div>`;
  }).join('');

  ids.forEach(id => {
    const el = document.querySelector(`[data-remote-id="${id}"]`);
    if (el) el.srcObject = peerStreams[id];
  });
}

function setActiveRemote(userId) {
  renderRemoteTiles();
  if (!userId) return;
  const stream = peerStreams[userId];
  if (!stream) return;
  const el = document.querySelector(`[data-remote-id="${userId}"]`);
  if (el) el.srcObject = stream;
}

function addLocalTracks(pc) {
  if (!local) return;
  const existing = pc.getSenders().map(s => s.track);
  local.getTracks().forEach(track => {
    if (!existing.includes(track)) pc.addTrack(track, local);
  });
}

function ensurePeerConnection(userId) {
  if (peerConnections[userId]) return peerConnections[userId];
  const pc = new RTCPeerConnection(iceCfg);
  pc.onicecandidate = e => e.candidate && socket.emit('webrtc:ice', { to: userId, data: e.candidate });
  pc.ontrack = e => {
    const stream = e.streams[0];
    peerStreams[userId] = stream;
    setActiveRemote(userId);
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc.connectionState)) sysMsg("Your friend's connection was interrupted. Attempting to reconnect…");
  };
  peerConnections[userId] = pc;
  addLocalTracks(pc);
  return pc;
}

$('callbtn').onclick = async () => {
  try { local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
  catch { sysMsg('Camera unavailable — you can continue watching with chat.'); local = null; }
  if (local) {
    selfcam.srcObject = local;
    selfcam.style.display = 'block';
    Object.keys(peerConnections).forEach(userId => addLocalTracks(peerConnections[userId]));
  }
  ['micbtn', 'cambtn', 'hangup'].forEach(i => $(i).disabled = false);
  $('callbtn').disabled = true;
  (state?.participants || []).filter(p => p.id !== me.id).forEach(p => {
    const peerPc = ensurePeerConnection(p.id);
    makeOffer(p.id);
  });
};

async function makeOffer(userId) {
  const pc = peerConnections[userId];
  if (!pc || pc.signalingState !== 'stable') return;
  const o = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(o);
  socket.emit('webrtc:offer', { to: userId, data: o });
}

async function onOffer(from, offer) {
  const pc = ensurePeerConnection(from);
  await pc.setRemoteDescription(offer);
  const a = await pc.createAnswer();
  await pc.setLocalDescription(a);
  socket.emit('webrtc:answer', { to: from, data: a });
}

function endCall(userId) {
  const ids = userId ? [userId] : Object.keys(peerConnections);
  ids.forEach(id => {
    const pc = peerConnections[id];
    if (pc) pc.close();
    delete peerConnections[id];
    const stream = peerStreams[id];
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      delete peerStreams[id];
    }
  });
  renderRemoteTiles();
  const nextPeer = Object.keys(peerStreams)[0];
  if (nextPeer) setActiveRemote(nextPeer); else { $('remote').srcObject = null; pip.style.display = 'none'; }
  if (!userId) {
    local?.getTracks().forEach(t => t.stop());
    local = null;
    selfcam.srcObject = null;
    selfcam.style.display = 'none';
    ['micbtn', 'cambtn', 'hangup'].forEach(i => $(i).disabled = true);
    $('callbtn').disabled = false;
  }
}

$('hangup').onclick = () => {
  socket.emit('webrtc:hangup', { to: Object.keys(peerConnections) });
  endCall();
};
$('micbtn').onclick = () => { const t = local?.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; $('micbtn').textContent = t.enabled ? '🎤' : '🔇'; } };
$('cambtn').onclick = () => { const t = local?.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; $('cambtn').textContent = t.enabled ? '📷' : '🚫'; } };

// Draggable floating friend video
(() => { let dx, dy, on = false;
  pip.addEventListener('pointerdown', e => { on = true; dx = e.clientX - pip.offsetLeft; dy = e.clientY - pip.offsetTop; pip.setPointerCapture(e.pointerId); });
  pip.addEventListener('pointermove', e => { if (!on) return; pip.style.left = (e.clientX - dx) + 'px'; pip.style.top = (e.clientY - dy) + 'px'; pip.style.right = 'auto'; });
  pip.addEventListener('pointerup', () => on = false);
})();

invite.onclick = () => { navigator.clipboard.writeText(location.href); invite.textContent = 'Link copied ✓'; };
function tab(t) { $('pane-movie').classList.toggle('hide', t !== 'movie'); $('pane-side').classList.toggle('hide', t !== 'side'); }
