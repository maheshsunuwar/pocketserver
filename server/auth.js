'use strict';
// Single-admin password login with session cookies.
const fs = require('fs');
const crypto = require('crypto');
const { state, save, flush } = require('./store');
const { paths, HttpError } = require('./util');

const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verify(pw) {
  const stored = state.settings.password;
  if (!stored || typeof pw !== 'string') return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  state.settings.password = hash(pw);
  state.sessions = {};
  try { fs.unlinkSync(paths.initialPassword); } catch {}
  state.settings.initialPassword = false;
  flush();
}
/** First run: create a random password and leave it in a private file for `pockethost start` to show. */
function ensurePassword() {
  if (state.settings.password) return;
  const pw = crypto.randomBytes(9).toString('base64url');
  state.settings.password = hash(pw);
  state.settings.initialPassword = true;
  fs.writeFileSync(paths.initialPassword, pw + '\n', { mode: 0o600 });
  flush();
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  state.sessions[sha(token)] = Date.now();
  save();
  return token;
}
function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
  return `ph_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function isLoggedIn(req) {
  const token = cookies(req).ph_session;
  if (!token) return false;
  const key = sha(token);
  const created = state.sessions[key];
  if (!created) return false;
  if (Date.now() - created > SESSION_DAYS * 86400e3) { delete state.sessions[key]; save(); return false; }
  return true;
}
function logout(req) {
  const token = cookies(req).ph_session;
  if (token) { delete state.sessions[sha(token)]; save(); }
}

// Slow down password guessing: 5 failures per IP → locked for a while.
const failures = new Map();
function checkRate(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.`);
  }
}
function recordFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (f.n - 5)); }
  failures.set(ip, f);
}
const clearFailures = (ip) => failures.delete(ip);

module.exports = {
  verify, setPassword, ensurePassword, createSession, sessionCookie, isLoggedIn, logout,
  checkRate, recordFailure, clearFailures,
};
