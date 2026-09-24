require('dotenv').config();
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const db = require('./db');
const R = require('./rooms');
const S = require('./security');

const PORT = 0;
const PROD = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(require('os').tmpdir(), 'cinesync-uploads');
const MAX_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 2048);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 7 * 864e5 },
});
app.use(sessionMiddleware);

// ---------- Auth ----------
// Name-based sign-in for local development.
app.post('/auth/dev', rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  if (PROD) return res.status(403).json({ error: 'Disabled in production.' });
  const name = String(req.body.name || 'Tester').slice(0, 40);
  const u = { id: 'u_dev_' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 10),
    name, email: `${name.toLowerCase()}@dev.local`, avatar_url: null };
  await db.upsertUser(u);
  req.session.user = { id: u.id, name: u.name, avatar: null, email: u.email };
  req.session.save(() => res.json({ ok: true }));
});

app.post('/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

const currentUser = req => req.session?.user || null;
const requireAuth = (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  req.user = u; next();
};

// ---------- API ----------
app.get('/api/me', (req, res) => res.json({ user: currentUser(req) }));

app.get('/api/config/ice', requireAuth, (req, res) => {
  const ice = [{ urls: process.env.STUN_SERVER || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_SERVER) ice.push({
    urls: process.env.TURN_SERVER, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
  res.json({ iceServers: ice });
});

const code = () => 'ROOM-' + crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, '').toUpperCase().slice(0, 6);

app.post('/api/rooms', requireAuth, rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || `${req.user.name}'s Watch Room`).trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Room name is required.' });
  for (let i = 0; i < 5; i++) {
    const rc = code();
    if (await db.getRoom(rc)) continue;
    const room = await db.createRoom({
      id: rc, room_code: rc, name, host_id: req.user.id,
      everyone_controls: !!b.everyoneControls, chat_enabled: b.chat !== false,
      call_enabled: b.call !== false, max_participants: Math.min(8, Math.max(2, Number(b.max) || 2)),
    });
    return res.json({ room, url: `/watch/${rc}` });
  }
  res.status(500).json({ error: 'Could not allocate a room code. Please try again.' });
});

app.get('/api/rooms/:code', requireAuth, async (req, res) => {
  const room = await db.getRoom(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Unable to join room. The room may have expired or does not exist.' });
  res.json({ room });
});

app.get('/api/rooms', requireAuth, async (req, res) => res.json({ rooms: await db.recentRooms(req.user.id) }));
app.get('/api/demo', requireAuth, (req, res) => res.json(R.DEMO));

// URL source validation (SSRF-guarded). We only validate; playback is direct
// from the browser so we never proxy arbitrary third-party media.
app.post('/api/media/validate-url', requireAuth, rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    const u = await S.assertSafeUrl(String(req.body.url || ''));
    const yt = u.hostname.match(/(?:^|\.)(youtube\.com|youtu\.be)$/);
    if (yt) {
      const id = u.hostname.includes('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v');
      if (!id) return res.status(400).json({ error: 'Could not read a video id from that YouTube link.' });
      return res.json({ type: 'youtube', url: id, title: 'YouTube video' });
    }
    if (!/\.(mp4|webm|mov|m4v)$/i.test(u.pathname))
      return res.status(400).json({ error: 'This video cannot be played directly inside the watch room. The source does not permit external playback. Try uploading a video you are authorized to share.' });
    res.json({ type: 'url', url: u.href, title: decodeURIComponent(u.pathname.split('/').pop()) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Upload ----------
const upload = multer({
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_r, file, cb) => {
      const ext = (path.extname(file.originalname).match(/^\.(mp4|webm|mov|m4v)$/i) || ['.mp4'])[0];
      cb(null, crypto.randomBytes(16).toString('hex') + ext.toLowerCase()); // sanitized, unpredictable
    },
  }),
  fileFilter: (_r, file, cb) => cb(null, S.ALLOWED_MIME.has(file.mimetype)),
});

app.post('/api/upload', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload failed. Only MP4, WebM and MOV files are accepted.' });
  const fd = fs.openSync(req.file.path, 'r'), buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0); fs.closeSync(fd);
  const real = S.sniff(buf); // magic bytes, not the extension
  if (!real) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'That file is not a supported video.' }); }
  res.json({ type: 'uploaded', url: `/media/${req.file.filename}`,
    title: String(req.file.originalname).slice(0, 200), size: req.file.size });
});

// Range-streaming media endpoint. Signed-in users only; never public.
app.get('/media/:file', requireAuth, (req, res) => {
  if (!/^[a-f0-9]{32}\.(mp4|webm|mov|m4v)$/.test(req.params.file)) return res.sendStatus(400);
  const file = path.join(UPLOAD_DIR, req.params.file);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const { size } = fs.statSync(file);
  const type = req.params.file.endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const range = req.headers.range;
  if (!range) { res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res); }
  const [s, e] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(s, 10) || 0, end = e ? parseInt(e, 10) : Math.min(start + 1e7, size - 1);
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1, 'Content-Type': type });
  fs.createReadStream(file, { start, end }).pipe(res); // streamed, never buffered in RAM
});

// ---------- Pages ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html')));
app.get('/watch/:code', (req, res) => {
  if (!currentUser(req)) { req.session.returnTo = req.originalUrl; return res.redirect('/'); }
  res.sendFile(path.join(__dirname, '..', 'public', 'watch.html'));
});
app.use((err, _req, res, _next) => { // never leak stack traces
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than the ${MAX_MB}MB limit.` : 'Something went wrong. Please try again.';
  res.status(400).json({ error: msg });
});

const server = app.listen(PORT, () => {
  const { port } = server.address();
  console.log(`CineSync on http://localhost:${port}`);
});
const io = new Server(server, { cors: { origin: false } });
require('./socket')(io, sessionMiddleware);
db.init().catch(e => console.error('[db]', e.message));
