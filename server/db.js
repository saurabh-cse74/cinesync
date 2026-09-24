// Data layer. Uses Postgres when DATABASE_URL is set, else an in-memory store
// so the app runs with zero infrastructure during development.
const fs = require('fs'), path = require('path');
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}
const mem = { users: new Map(), rooms: new Map(), members: new Map(), messages: [] };
const q = (t, p) => pool.query(t, p);

async function init() {
  if (!pool) return console.warn('[db] DATABASE_URL unset - using in-memory store');
  await q(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  console.log('[db] postgres ready');
}
async function upsertUser(u) {
  if (!pool) { mem.users.set(u.id, { ...u, created_at: new Date(), last_active: new Date() }); return mem.users.get(u.id); }
  const { rows } = await q(`INSERT INTO users (id,name,email,avatar_url) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url, last_active=now() RETURNING *`,
    [u.id, u.name, u.email, u.avatar_url]);
  return rows[0];
}
async function createRoom(r) {
  if (!pool) { mem.rooms.set(r.room_code, { ...r, created_at: new Date(), is_active: true }); return mem.rooms.get(r.room_code); }
  const { rows } = await q(`INSERT INTO rooms (id,room_code,name,host_id,everyone_controls,chat_enabled,call_enabled,max_participants)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [r.id, r.room_code, r.name, r.host_id, r.everyone_controls, r.chat_enabled, r.call_enabled, r.max_participants]);
  return rows[0];
}
async function getRoom(code) {
  if (!pool) return mem.rooms.get(code) || null;
  const { rows } = await q(`SELECT * FROM rooms WHERE room_code=$1 AND is_active AND expires_at > now()`, [code]);
  return rows[0] || null;
}
async function addMember(roomId, userId) {
  if (!pool) { const s = mem.members.get(roomId) || new Set(); s.add(userId); mem.members.set(roomId, s); return; }
  await q(`INSERT INTO room_members (room_id,user_id) VALUES ($1,$2)
           ON CONFLICT (room_id,user_id) DO UPDATE SET last_seen=now()`, [roomId, userId]);
}
async function recentRooms(userId) {
  if (!pool) return [...mem.rooms.values()].filter(r => r.host_id === userId ||
    (mem.members.get(r.id) || new Set()).has(userId)).reverse().slice(0, 10);
  const { rows } = await q(`SELECT r.* FROM rooms r LEFT JOIN room_members m ON m.room_id=r.id
    WHERE (r.host_id=$1 OR m.user_id=$1) AND r.is_active GROUP BY r.id ORDER BY r.created_at DESC LIMIT 10`, [userId]);
  return rows;
}
async function saveMessage(roomId, userId, message) {
  if (!pool) { mem.messages.push({ roomId, userId, message, created_at: new Date() }); return; }
  await q(`INSERT INTO messages (room_id,user_id,message) VALUES ($1,$2,$3)`, [roomId, userId, message]).catch(() => {});
}
async function saveMedia(roomId, m) {
  if (!pool) return;
  await q(`INSERT INTO media (room_id,type,title,url) VALUES ($1,$2,$3,$4)`, [roomId, m.type, m.title, m.url]).catch(() => {});
}
module.exports = { init, upsertUser, createRoom, getRoom, addMember, recentRooms, saveMessage, saveMedia };
