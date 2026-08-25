/* ============================================================
   NEXUS API — backend системы аккаунтов
   ------------------------------------------------------------
   Стек: Express + SQLite (better-sqlite3) + bcryptjs
   Безопасность:
     • пароли хранятся ТОЛЬКО в виде bcrypt-хеша (12 раундов)
     • сессия = случайный токен, в БД лежит только sha256(токен)
     • токен передаётся в httpOnly cookie (недоступна JS в браузере)
     • «Запомнить меня» -> cookie на 30 дней, иначе сессионная cookie
     • единая ошибка входа (не раскрываем существование username)
     • rate limiting на /login и /register
   Запуск:  npm install && npm start
   ============================================================ */
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

/* ---------- Конфигурация (переменные окружения) ---------- */
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
/* Список разрешённых источников через запятую, например:
   ORIGINS=https://daniklavrik547-lab.github.io,http://localhost:3000 */
const ORIGINS = (process.env.ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const COOKIE_NAME = 'nexus_sid';
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; /* 30 дней */
const BCRYPT_ROUNDS = 12;

/* ---------- База данных ---------- */
const db = new Database(path.join(__dirname, 'nexus.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    settings      TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const qUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const qUserByEmail    = db.prepare('SELECT * FROM users WHERE email = ?');
const qUserById       = db.prepare('SELECT * FROM users WHERE id = ?');
const qInsertUser     = db.prepare('INSERT INTO users (username, email, password_hash, settings) VALUES (?, ?, ?, ?)');
const qInsertSession  = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
const qSession        = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
const qDeleteSession  = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const qDeleteExpired  = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
const qUpdateSettings = db.prepare('UPDATE users SET settings = ? WHERE id = ?');

/* Фиктивный хеш: выравнивает время ответа, когда username не найден
   (защита от перебора имён по скорости ответа) */
const DUMMY_HASH = bcrypt.hashSync('nexus-timing-equalizer', BCRYPT_ROUNDS);

/* ---------- Приложение ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); /* curl, health-check, same-origin */
    if (ORIGINS.includes('*') || ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true
}));

/* Rate limiting: защита от перебора паролей */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' }
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' }
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api', apiLimiter);

/* ---------- Утилиты ---------- */
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/* В ответах API никогда нет password_hash */
function publicUser(row) {
  let settings = {};
  try { settings = JSON.parse(row.settings || '{}'); } catch (e) {}
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
    settings
  };
}

function setSessionCookie(res, token, remember) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,          /* cookie недоступна из JS — защита от кражи */
    secure: IS_PROD,         /* только HTTPS в продакшене */
    /* SameSite=None: сайт (GitHub Pages) и API (Render) — разные сайты.
       Lax не отправлял cookie в cross-site fetch — сессия «сразу истекала».
       SameSite=None работает только вместе с Secure. */
    sameSite: IS_PROD ? 'none' : 'lax',
    ...(remember ? { maxAge: REMEMBER_MS } : {})   /* без maxAge сессия умирает с браузером */
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax'
  });
}

function createSession(res, userId, remember) {
  const token = crypto.randomBytes(32).toString('hex');
  qInsertSession.run(sha256(token), userId, Date.now() + REMEMBER_MS);
  qDeleteExpired.run(Date.now()); /* уборка просроченных сессий */
  setSessionCookie(res, token, remember);
}

/* Мидлварь авторизации: решение принимает сервер, не клиент */
function requireAuth(req, res, next) {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return res.status(401).json({ error: 'unauthorized' });

  const sess = qSession.get(sha256(raw));
  if (!sess || sess.expires_at < Date.now()) {
    if (sess) qDeleteSession.run(sess.token_hash);
    return res.status(401).json({ error: 'unauthorized' });
  }

  const user = qUserById.get(sess.user_id);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  req.user = user;
  next();
}

/* ---------- Валидация ---------- */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------- Маршруты API ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'nexus-api' }));

/* Регистрация нового аккаунта */
app.post('/api/register', (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!username || !email || !password) return res.status(400).json({ error: 'missing_fields' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email' });
  if (!password || Buffer.byteLength(password) > 72) return res.status(400).json({ error: 'invalid_password' });

  if (qUserByUsername.get(username)) return res.status(409).json({ error: 'username_taken' });
  if (qUserByEmail.get(email)) return res.status(409).json({ error: 'email_taken' });

  const settings = JSON.stringify({
    displayName: username,
    avatar: '',            /* '' -> клиент выберет случайный эмодзи */
    accent: 'cyan',
    themeMode: 'dark',
    customTheme: false
  });

  const info = qInsertUser.run(username, email, bcrypt.hashSync(password, BCRYPT_ROUNDS), settings);
  const user = qUserById.get(info.lastInsertRowid);
  res.status(201).json({ user: publicUser(user) });
});

/* Вход: проверка пароля на сервере + создание сессии */
app.post('/api/login', (req, res) => {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const remember = body.remember === true;

  if (!username || !password) return res.status(400).json({ error: 'missing_fields' });

  const user = qUserByUsername.get(username);
  if (!user) {
    bcrypt.compareSync(password, DUMMY_HASH); /* одинаковое время ответа */
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  createSession(res, user.id, remember);
  res.json({ user: publicUser(user) });
});

/* Выход: сессия уничтожается на сервере + cookie очищается */
app.post('/api/logout', (req, res) => {
  const raw = req.cookies[COOKIE_NAME];
  if (raw) qDeleteSession.run(sha256(raw));
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* Текущий пользователь по сессии (автовход при открытии сайта) */
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* Сохранение настроек пользователя (avatar, displayName, accent, theme...) */
app.patch('/api/settings', requireAuth, (req, res) => {
  const s = req.body && req.body.settings;
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return res.status(400).json({ error: 'invalid_settings' });
  }
  const json = JSON.stringify(s);
  if (json.length > 16384) return res.status(400).json({ error: 'settings_too_large' });

  qUpdateSettings.run(json, req.user.id);
  res.json({ user: publicUser(qUserById.get(req.user.id)) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`NEXUS API запущен: http://localhost:${PORT} (режим: ${NODE_ENV})`);
});
