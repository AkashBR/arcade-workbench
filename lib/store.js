// Storage: one SQLite file, opened with the driver built into Node. No dependencies.
// Everything a person makes (flows, run history, connections, prompts) is a row tied to their user.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = path.join(DATA_DIR, 'config.json');
const DEFAULT_DB = path.join(DATA_DIR, 'workbench.db');
const SESSION_DAYS = 14;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, flow_id TEXT, flow_name TEXT, batch_id TEXT, node_id TEXT, node_type TEXT NOT NULL, title TEXT NOT NULL,
    endpoint TEXT, world TEXT, status TEXT NOT NULL, http_status INTEGER, error TEXT, ms INTEGER, summary TEXT, started_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS runs_user ON runs (user_id, started_at);
  CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, preset TEXT, name TEXT NOT NULL, base_url TEXT, model TEXT,
    key_mode TEXT NOT NULL DEFAULT 'own', key_enc TEXT, key_hint TEXT, last_test TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS watch (id TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, changes TEXT, snapshot TEXT, checked_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, world TEXT, category TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL);
`;

let db = null;
let dbPath = null;

const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
// Opens the new file first, so a bad path leaves the current database in place.
function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = new DatabaseSync(file);
  next.exec(SCHEMA);
  if (db) db.close();
  db = next;
  dbPath = file;
}
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  open(path.resolve(process.env.DATABASE_PATH || readConfig().databasePath || DEFAULT_DB));
}
function connect(file) {
  const resolved = path.resolve(String(file || '').trim());
  if (!/\.(db|sqlite|sqlite3)$/i.test(resolved)) throw new Error('The path must end in .db, .sqlite or .sqlite3.');
  open(resolved);
  fs.writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), databasePath: resolved }, null, 2));
}
const info = () => ({ path: dbPath, isDefault: dbPath === DEFAULT_DB, sizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0 });

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ---------- secrets at rest ----------
// API keys are encrypted with a secret that is kept outside the database:
// WORKBENCH_SECRET if set, otherwise a random one written to data/secret.key.
function secret() {
  if (process.env.WORKBENCH_SECRET) return crypto.createHash('sha256').update(process.env.WORKBENCH_SECRET).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function unseal(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', secret(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// ---------- users and sessions ----------
const hashPass = (password, salt) => crypto.scryptSync(String(password), salt, 64).toString('hex');
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
function createUser(username, password, role = 'member') {
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: id(), username, role };
  run('INSERT INTO users (id, username, pass_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', user.id, username, hashPass(password, salt), salt, role, now());
  return user;
}
function verifyUser(username, password) {
  const u = get('SELECT * FROM users WHERE username = ?', username);
  // Hash even when the user is missing, so a wrong name and a wrong password take the same time.
  const given = Buffer.from(hashPass(password, u ? u.salt : 'no-such-user'), 'hex');
  if (!u || !crypto.timingSafeEqual(given, Buffer.from(u.pass_hash, 'hex'))) return null;
  return { id: u.id, username: u.username, role: u.role };
}
// Accounts listed in WORKBENCH_USERS ("name:password,name:password") exist on every start; the first is the admin.
function seedUsers(spec) {
  String(spec || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((pair, i) => {
    const cut = pair.indexOf(':');
    if (cut < 1) return;
    const username = pair.slice(0, cut).toLowerCase(), password = pair.slice(cut + 1);
    const existing = get('SELECT id FROM users WHERE username = ?', username);
    if (!existing) return createUser(username, password, i === 0 ? 'admin' : 'member');
    const salt = crypto.randomBytes(16).toString('hex');
    run('UPDATE users SET pass_hash = ?, salt = ?, role = ? WHERE id = ?', hashPass(password, salt), salt, i === 0 ? 'admin' : 'member', existing.id);
  });
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash(token), userId, Date.now() + SESSION_DAYS * 864e5);
  return token;
}
const sessionUser = (token) => get('SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', tokenHash(token), Date.now()) || null;
const endSession = (token) => run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));

module.exports = { init, connect, info, all, get, run, id, now, seal, unseal, createUser, verifyUser, seedUsers, createSession, sessionUser, endSession, SESSION_DAYS };
