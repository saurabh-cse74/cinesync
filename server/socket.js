const R = require('./rooms');
const db = require('./db');
const { escapeHtml } = require('./security');

module.exports = function attach(io, sessionMiddleware) {
  io.engine.use(sessionMiddleware);

  // WebSocket authentication: reuse the HTTP session. No session, no socket.
  io.use((socket, next) => {
    const u = socket.request.session?.user;
    if (!u) return next(new Error('unauthenticated'));
    socket.user = u;
    next();
  });

  io.on('connection', socket => {
    let code = null;
    const room = () => (code ? R.get(code) : null);
    const sys = text => io.to(code).emit('chat:message', { system: true, text, at: Date.now() });

    socket.on('room:join', async ({ roomCode }, ack) => {
      const meta = await db.getRoom(String(roomCode || '').toUpperCase());
      if (!meta) return ack?.({ error: 'Unable to join room. The room may have expired or does not exist.' });
      code = meta.room_code;
      const r = R.ensure(code, {
        hostId: meta.host_id, name: meta.name, everyoneControls: meta.everyone_controls,
        chatEnabled: meta.chat_enabled, callEnabled: meta.call_enabled, maxParticipants: meta.max_participants,
      });
      const existing = r.participants.get(socket.user.id);
      if (!existing && r.participants.size >= r.maxParticipants)
        return ack?.({ error: 'This room is full.' });

      const p = existing || { ...socket.user, sockets: new Set() };
      p.sockets.add(socket.id);
      r.participants.set(socket.user.id, p);
      socket.join(code);
      await db.addMember(meta.id, socket.user.id);

      if (!existing) sys(`${socket.user.name} joined the room`);
      ack?.({ ok: true, state: R.snapshot(r), you: socket.user.id });
      io.to(code).emit('room:state', R.snapshot(r));
      // The second peer initiates the WebRTC offer.
      socket.to(code).emit('peer:joined', { userId: socket.user.id });
    });

    socket.on('playback:control', payload => {
      const r = room(); if (!r) return;
      if (!R.canControl(r, socket.user.id)) return socket.emit('room:error', 'You do not have playback control.');
      if (!R.applyPlayback(r, payload || {})) return;
      // Broadcast to everyone INCLUDING sender's room peers; the originating
      // client tags the update with its own id and ignores its own echo.
      io.to(code).emit('PLAYBACK_UPDATE', { ...R.snapshot(r).playback, by: socket.user.id, serverNow: Date.now() });
    });

    socket.on('media:change', async payload => {
      const r = room(); if (!r) return;
      if (!R.canControl(r, socket.user.id)) return socket.emit('room:error', 'Only the host can change the video.');
      const m = { type: String(payload.type || 'url'), title: String(payload.title || 'Video').slice(0, 200), url: String(payload.url || '') };
      if (!/^https?:\/\/|^\/media\//.test(m.url)) return socket.emit('room:error', 'Invalid media URL.');
      r.media = m;
      r.playback = { isPlaying: false, currentTime: 0, playbackRate: 1, updatedAt: Date.now() };
      const meta = await db.getRoom(code); if (meta) db.saveMedia(meta.id, m);
      io.to(code).emit('room:state', R.snapshot(r));
      sys(`Video changed to "${m.title}"`);
    });

    socket.on('room:settings', ({ everyoneControls }) => {
      const r = room(); if (!r || r.hostId !== socket.user.id) return;
      r.everyoneControls = !!everyoneControls;
      io.to(code).emit('room:state', R.snapshot(r));
    });

    // Client asks for authoritative state after reconnect / tab focus.
    socket.on('sync:request', ack => { const r = room(); if (r) ack?.(R.snapshot(r)); });

    socket.on('chat:send', async text => {
      const r = room(); if (!r || !r.chatEnabled) return;
      const clean = escapeHtml(String(text || '').trim()).slice(0, 1000);
      if (!clean) return;
      const meta = await db.getRoom(code); if (meta) db.saveMessage(meta.id, socket.user.id, clean);
      io.to(code).emit('chat:message', { userId: socket.user.id, name: socket.user.name, text: clean, at: Date.now() });
    });

    socket.on('reaction', emoji => {
      const r = room(); if (!r) return;
      if (!['❤️', '😂', '😮', '😭', '🔥', '👍'].includes(emoji)) return;
      io.to(code).emit('reaction', { emoji, userId: socket.user.id });
    });

    // --- WebRTC signaling relay (SDP + ICE). Server never inspects payloads. ---
    ['webrtc:offer', 'webrtc:answer', 'webrtc:ice', 'webrtc:hangup'].forEach(ev =>
      socket.on(ev, data => { if (code) socket.to(code).emit(ev, { from: socket.user.id, data }); }));

    socket.on('disconnect', () => {
      const r = room(); if (!r) return;
      const p = r.participants.get(socket.user.id); if (!p) return;
      p.sockets.delete(socket.id);
      if (p.sockets.size === 0) {
        sys(`${socket.user.name} disconnected`);
        socket.to(code).emit('peer:left', { userId: socket.user.id });
        setTimeout(() => { // grace period for reconnects
          const rr = R.get(code);
          if (rr && rr.participants.get(socket.user.id)?.sockets.size === 0) {
            rr.participants.delete(socket.user.id);
            io.to(code).emit('room:state', R.snapshot(rr));
            if (rr.participants.size === 0) R.destroy(code);
          }
        }, 30000);
      }
      io.to(code).emit('room:state', R.snapshot(r));
    });
  });
};
