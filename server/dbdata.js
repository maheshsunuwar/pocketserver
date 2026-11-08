'use strict';
// Browse and edit data in PocketServer's databases from the dashboard.
// PostgreSQL and MariaDB go through their own command-line clients (no npm drivers);
// Redis uses a tiny built-in client. User values never get pasted into SQL text:
// psql gets them as quoted variables, MariaDB as hex literals.
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const U = require('./util');
const { state } = require('./store');
const S = require('./supervisor');

const MAX_LIMIT = 500;

function getDb(id) {
  const d = state.databases[id];
  if (!d) throw new U.HttpError(404, 'Database not found.');
  if (S.info(id).status !== 'running' || !d.initialized) throw new U.HttpError(409, 'Start the database first.');
  return d;
}

function exec(file, args, { input, env, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    const out = []; const err = [];
    let size = 0;
    child.stdout.on('data', (c) => { size += c.length; if (size < 64 * 1024 * 1024) out.push(c); });
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code === 0) resolve(stdout);
      else reject(new U.HttpError(400, cleanError(stderr) || `Query failed (exit code ${code}).`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
const cleanError = (s) => s.replace(/^-{5,}\n[\s\S]*?\n-{5,}\n?/gm, '').split('\n').filter((l) => !/^(psql:)?\s*$/.test(l)).join('\n')
  .replace(/^psql:<stdin>:\d+: /gm, '').replace(/^ERROR \d+ \(\w+\) at line \d+: /gm, '').slice(0, 2000);

const parseJson = (s, fallback) => { const t = s.trim(); if (!t || t === 'NULL') return fallback; return JSON.parse(t); };
const clampLimit = (n) => Math.max(1, Math.min(MAX_LIMIT, Number(n) || 50));
const clampOffset = (n) => Math.max(0, Math.floor(Number(n) || 0));
const asText = (v) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------------- PostgreSQL ----------------
const pg = {
  /** Runs SQL through psql. `vars` become :'name' (literal) / :"name" (identifier) in the SQL. */
  run(d, sql, vars = {}, extra = []) {
    const args = ['-h', '127.0.0.1', '-p', String(d.port), '-U', 'postgres', '-d', d.dbName, '-X', '-v', 'ON_ERROR_STOP=1', ...extra];
    for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
    return exec('psql', args, { input: sql, env: { ...process.env, PGPASSWORD: d.password, PGCONNECT_TIMEOUT: '5' } });
  },
  json: (d, sql, vars) => pg.run(d, sql, vars, ['-A', '-t', '-q']).then((s) => parseJson(s, null)),

  async tables(d) {
    return (await pg.json(d, `
      select coalesce(json_agg(json_build_object('schema', table_schema, 'name', table_name, 'view', table_type <> 'BASE TABLE')
        order by table_schema <> 'public', table_schema, table_name), '[]')
      from information_schema.tables
      where table_schema not in ('pg_catalog', 'information_schema') and table_schema not like 'pg_toast%';`)) || [];
  },

  async columns(d, schema, table) {
    const cols = await pg.json(d, `
      select coalesce(json_agg(json_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
        'pk', coalesce(a.attnum = any(i.indkey), false), 'nullable', not a.attnotnull,
        'default', pg_get_expr(df.adbin, df.adrelid)) order by a.attnum), '[]')
      from pg_attribute a
      left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
      left join pg_attrdef df on df.adrelid = a.attrelid and df.adnum = a.attnum
      where a.attrelid = (quote_ident(:'s') || '.' || quote_ident(:'t'))::regclass and a.attnum > 0 and not a.attisdropped;`,
    { s: schema, t: table });
    if (!cols || !cols.length) throw new U.HttpError(404, 'Table not found.');
    return cols;
  },

  async rows(d, schema, table, cols, limit, offset) {
    const vars = { s: schema, t: table };
    cols.forEach((c, i) => { vars['c' + i] = c.name; });
    const order = cols.some((c) => c.pk) ? 'order by ' + cols.map((c, i) => (c.pk ? `:"c${i}"` : null)).filter(Boolean).join(', ') : '';
    // Cast every value to text so arrays, timestamps etc. come back in the same format
    // Postgres accepts when the edited value is saved.
    const select = cols.map((c, i) => `:"c${i}"::text as :"c${i}"`).join(', ');
    const [rows, total] = await Promise.all([
      pg.json(d, `
        select coalesce(json_agg(row_to_json(r)), '[]')
        from (select ${select} from :"s".:"t" ${order} limit ${limit} offset ${offset}) r;`, vars),
      pg.json(d, 'select count(*) from :"s".:"t";', vars),
    ]);
    return { rows: rows || [], total: Number(total) };
  },

  async write(d, schema, table, op, cols, key, values) {
    const vars = { s: schema, t: table };
    let n = 0;
    const ident = (name) => { vars['i' + n] = name; return `:"i${n++}"`; };
    const lit = (v) => { if (v === null) return 'NULL'; vars['v' + n] = v; return `:'v${n++}'`; };
    const where = () => Object.entries(key).map(([c, v]) => (v === null ? `${ident(c)} is null` : `${ident(c)} = ${lit(v)}`)).join(' and ');
    let sql;
    if (op === 'insert') {
      const entries = Object.entries(values);
      sql = entries.length
        ? `insert into :"s".:"t" (${entries.map(([c]) => ident(c)).join(', ')}) values (${entries.map(([, v]) => lit(v)).join(', ')}) returning 1`
        : 'insert into :"s".:"t" default values returning 1';
    } else if (op === 'update') {
      sql = `update :"s".:"t" set ${Object.entries(values).map(([c, v]) => `${ident(c)} = ${lit(v)}`).join(', ')} where ${where()} returning 1`;
    } else {
      sql = `delete from :"s".:"t" where ${where()} returning 1`;
    }
    return Number(await pg.json(d, `with x as (${sql}) select count(*) from x;`, vars));
  },

  async query(d, sql) {
    const out = await pg.run(d, sql, {}, ['--csv']);
    return resultFromCsv(out);
  },
};

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false; let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') { quoted = true; wasQuoted = true; } else if (ch === ',') { row.push(cell === '' && !wasQuoted ? null : cell); cell = ''; wasQuoted = false; } else if (ch === '\n') {
      row.push(cell === '' && !wasQuoted ? null : cell); rows.push(row); row = []; cell = ''; wasQuoted = false;
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length || wasQuoted) { row.push(cell === '' && !wasQuoted ? null : cell); rows.push(row); }
  return rows;
}
function resultFromCsv(out) {
  // Commands like UPDATE print a status line ("UPDATE 3") instead of a table. With several
  // statements, keep the status lines as a message and show the table from the query.
  const isStatus = (l) => /^[A-Z][A-Z ]*( \d+)*$/.test(l);
  const all = out.replace(/\n+$/, '').split('\n');
  const status = [];
  while (all.length && isStatus(all[0])) status.push(all.shift());
  while (all.length && isStatus(all[all.length - 1])) status.push(all.pop());
  const message = status.join(' · ') || undefined;
  if (!all.length) return { message: message || 'Done.' };
  const text = all.join('\n');
  const lines = parseCsv(text + '\n');
  const columns = lines[0].map(String);
  const rows = lines.slice(1).filter((r) => r.length === columns.length);
  return { columns, rows: rows.slice(0, 1000), truncated: rows.length > 1000, message };
}

// ---------------- MariaDB ----------------
const hexLit = (v) => (v === null ? 'NULL' : `CONVERT(X'${Buffer.from(String(v), 'utf8').toString('hex')}' USING utf8mb4)`);
const bt = (name) => '`' + String(name).replace(/`/g, '``') + '`';

const my = {
  run(d, sql, extra = []) {
    const dir = path.join(U.paths.dbs, d.id);
    return exec('mariadb', [`--socket=${path.join(dir, 'mysql.sock')}`, '-u', os.userInfo().username, '-D', d.dbName, '--default-character-set=utf8mb4', ...extra], { input: sql });
  },
  json: (d, sql) => my.run(d, `SET SESSION group_concat_max_len = 67108864;\n${sql}`, ['-N', '-B', '-r']).then((s) => parseJson(s.split('\n').filter(Boolean).pop() || '', null)),

  async tables(d) {
    return ((await my.json(d, `SELECT JSON_ARRAYAGG(JSON_OBJECT('name', TABLE_NAME, 'view', TABLE_TYPE = 'VIEW') ORDER BY TABLE_NAME)
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();`)) || []).map((t) => ({ ...t, view: !!t.view }));
  },

  async columns(d, table) {
    const cols = await my.json(d, `SELECT JSON_ARRAYAGG(JSON_OBJECT('name', COLUMN_NAME, 'type', COLUMN_TYPE, 'pk', COLUMN_KEY = 'PRI',
        'nullable', IS_NULLABLE = 'YES', 'default', COLUMN_DEFAULT, 'auto', EXTRA LIKE '%auto_increment%') ORDER BY ORDINAL_POSITION)
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${hexLit(table)};`);
    if (!cols || !cols.length) throw new U.HttpError(404, 'Table not found.');
    // MariaDB reports "no default" as the text NULL (real string defaults are quoted).
    return cols.map((c) => ({ ...c, pk: !!c.pk, nullable: !!c.nullable, auto: !!c.auto, default: c.default === 'NULL' ? null : c.default }));
  },

  async rows(d, table, cols, limit, offset) {
    const pk = cols.filter((c) => c.pk);
    const order = pk.length ? 'ORDER BY ' + pk.map((c) => bt(c.name)).join(', ') : '';
    const obj = cols.map((c) => `${hexLit(c.name)}, CAST(${bt(c.name)} AS CHAR)`).join(', ');
    const rows = await my.json(d, `SELECT JSON_ARRAYAGG(JSON_OBJECT(${obj}) ${order})
      FROM (SELECT * FROM ${bt(table)} ${order} LIMIT ${limit} OFFSET ${offset}) r;`);
    const total = await my.json(d, `SELECT COUNT(*) FROM ${bt(table)};`);
    return { rows: rows || [], total: Number(total) };
  },

  async write(d, table, op, cols, key, values) {
    const where = () => Object.entries(key).map(([c, v]) => (v === null ? `${bt(c)} IS NULL` : `${bt(c)} = ${hexLit(v)}`)).join(' AND ');
    let sql;
    if (op === 'insert') {
      const e = Object.entries(values);
      sql = e.length ? `INSERT INTO ${bt(table)} (${e.map(([c]) => bt(c)).join(', ')}) VALUES (${e.map(([, v]) => hexLit(v)).join(', ')});\nSELECT ROW_COUNT();`
        : `INSERT INTO ${bt(table)} () VALUES ();\nSELECT ROW_COUNT();`;
    } else {
      // The key is the full primary key, so at most one row matches. Count matches first:
      // ROW_COUNT() after an UPDATE is 0 when the new values equal the old ones.
      const change = op === 'update'
        ? `UPDATE ${bt(table)} SET ${Object.entries(values).map(([c, v]) => `${bt(c)} = ${hexLit(v)}`).join(', ')} WHERE ${where()} LIMIT 1`
        : `DELETE FROM ${bt(table)} WHERE ${where()} LIMIT 1`;
      sql = `SELECT COUNT(*) INTO @found FROM ${bt(table)} WHERE ${where()};\n${change};\nSELECT @found;`;
    }
    const out = await my.run(d, sql + '\n', ['-N', '-B']);
    return Number(out.trim().split('\n').pop());
  },

  async query(d, sql) {
    const out = await my.run(d, sql, ['--xml']);
    return resultFromXml(out);
  },
};

const unxml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]
  ?? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
function resultFromXml(xml) {
  const sets = [...xml.matchAll(/<resultset[^>]*>([\s\S]*?)<\/resultset>/g)].map((m) => m[1]);
  if (!sets.length) return { message: 'Done.' };
  const last = sets[sets.length - 1];
  const columns = []; const rows = [];
  for (const r of last.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const f of r[1].matchAll(/<field name="([^"]*)"(\s+xsi:nil="true"\s*\/>|>([\s\S]*?)<\/field>|\s*\/>)/g)) {
      const name = unxml(f[1]);
      if (rows.length === 0) columns.push(name);
      row.push(f[2].includes('nil') ? null : unxml(f[3] || ''));
    }
    rows.push(row);
  }
  if (!rows.length) return { columns: [], rows: [], message: 'No rows.' };
  return { columns, rows: rows.slice(0, 1000), truncated: rows.length > 1000 };
}

// ---------------- Redis ----------------
function encodeCmd(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) { const b = Buffer.from(String(a), 'utf8'); parts.push(`$${b.length}\r\n`, b, '\r\n'); }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}
/** Parses one RESP2 reply from buf at pos. Returns [value, nextPos] or null when incomplete. */
function parseReply(buf, pos = 0) {
  const nl = buf.indexOf('\r\n', pos);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, nl);
  if (type === '+') return [line, nl + 2];
  if (type === '-') return [new RedisError(line), nl + 2];
  if (type === ':') return [Number(line), nl + 2];
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return [null, nl + 2];
    if (buf.length < nl + 2 + len + 2) return null;
    return [buf.toString('utf8', nl + 2, nl + 2 + len), nl + 2 + len + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return [null, nl + 2];
    const arr = []; let p = nl + 2;
    for (let i = 0; i < n; i++) { const r = parseReply(buf, p); if (!r) return null; arr.push(r[0]); p = r[1]; }
    return [arr, p];
  }
  throw new Error('Unexpected reply from Redis.');
}
class RedisError extends Error {}

/** Sends commands over one short-lived connection and returns their replies. */
function redis(d, commands) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(d.port, '127.0.0.1');
    const all = [['AUTH', d.password], ...commands];
    let buf = Buffer.alloc(0); const replies = [];
    const done = (err) => { sock.destroy(); clearTimeout(timer); if (err) reject(err); else resolve(replies.slice(1)); };
    const timer = setTimeout(() => done(new U.HttpError(504, 'Redis took too long to answer.')), 10000);
    sock.on('connect', () => sock.write(Buffer.concat(all.map(encodeCmd))));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      let r;
      try {
        while ((r = parseReply(buf))) { replies.push(r[0]); buf = buf.subarray(r[1]); }
      } catch (e) { done(e); return; }
      if (replies.length >= all.length) {
        if (replies[0] instanceof RedisError) done(new U.HttpError(500, 'Redis rejected the password.'));
        else done();
      }
    });
    sock.on('error', (e) => done(new U.HttpError(502, `Couldn't reach Redis: ${e.message}`)));
  });
}
const check = (v) => { if (v instanceof RedisError) throw new U.HttpError(400, v.message); return v; };

const rd = {
  async keys(d, match, cursor) {
    const [res] = await redis(d, [['SCAN', cursor || '0', 'MATCH', match || '*', 'COUNT', '200']]);
    const [next, names] = check(res);
    const meta = names.length ? await redis(d, names.flatMap((n) => [['TYPE', n], ['PTTL', n]])) : [];
    const keys = names.map((name, i) => ({ name, type: meta[i * 2], ttl: meta[i * 2 + 1] >= 0 ? Math.ceil(meta[i * 2 + 1] / 1000) : null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const [size] = await redis(d, [['DBSIZE']]);
    return { keys, cursor: next === '0' ? null : next, total: size };
  },
  async get(d, name) {
    const [type, pttl] = await redis(d, [['TYPE', name], ['PTTL', name]]);
    if (type === 'none') throw new U.HttpError(404, 'That key no longer exists.');
    const cmd = {
      string: ['GET', name], hash: ['HGETALL', name], list: ['LRANGE', name, '0', '499'],
      set: ['SRANDMEMBER', name, '500'], zset: ['ZRANGE', name, '0', '499', 'WITHSCORES'],
    }[type];
    const lenCmd = { hash: ['HLEN', name], list: ['LLEN', name], set: ['SCARD', name], zset: ['ZCARD', name] }[type];
    const [value, length] = cmd ? await redis(d, [cmd, ...(lenCmd ? [lenCmd] : [])]) : [null];
    let v = check(value);
    if (type === 'hash' || type === 'zset') { const pairs = []; for (let i = 0; i < v.length; i += 2) pairs.push([v[i], v[i + 1]]); v = pairs; }
    if (type === 'set' && Array.isArray(v)) v.sort();
    return { name, type, ttl: pttl >= 0 ? Math.ceil(pttl / 1000) : null, value: cmd ? v : null, length: length ?? null };
  },
  async setString(d, name, value, ttl) {
    const args = ['SET', name, value];
    if (ttl) args.push('EX', String(ttl));
    check((await redis(d, [args]))[0]);
  },
  async hashSet(d, name, fieldName, value) { check((await redis(d, [['HSET', name, fieldName, value]]))[0]); },
  async hashDel(d, name, fieldName) { check((await redis(d, [['HDEL', name, fieldName]]))[0]); },
  async del(d, name) { return check((await redis(d, [['DEL', name]]))[0]); },
  async command(d, line) {
    const args = splitArgs(line);
    if (!args.length) throw U.bad('Type a command.');
    const [res] = await redis(d, [args]);
    if (res instanceof RedisError) throw new U.HttpError(400, res.message);
    return { reply: res };
  },
};

function splitArgs(line) {
  const out = []; let cur = ''; let q = null; let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '\\' && i + 1 < line.length) cur += line[++i]; else if (ch === q) q = null; else cur += ch; } else if (ch === '"' || ch === "'") { q = ch; has = true; } else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

// ---------------- public API ----------------
function tableArgs(d, q) {
  const table = String(q.get('table') || '');
  if (!table) throw U.bad('Pick a table.');
  return { table, schema: d.type === 'postgres' ? String(q.get('schema') || 'public') : null };
}

async function tables(id) {
  const d = getDb(id);
  if (d.type === 'postgres') return pg.tables(d);
  if (d.type === 'mariadb') return my.tables(d);
  throw U.bad('Redis has keys, not tables.');
}

async function rows(id, q) {
  const d = getDb(id);
  const { table, schema } = tableArgs(d, q);
  const limit = clampLimit(q.get('limit'));
  const offset = clampOffset(q.get('offset'));
  const columns = d.type === 'postgres' ? await pg.columns(d, schema, table) : await my.columns(d, table);
  const r = d.type === 'postgres'
    ? await pg.rows(d, schema, table, columns, limit, offset)
    : await my.rows(d, table, columns, limit, offset);
  return { columns, ...r, limit, offset, editable: columns.some((c) => c.pk) };
}

/** body: { table, schema?, op: insert|update|delete, key?: {col: val}, values?: {col: val} } */
async function write(id, body) {
  const d = getDb(id);
  if (d.type === 'redis') throw U.bad('Use the key editor for Redis.');
  const table = String(body.table || '');
  const schema = d.type === 'postgres' ? String(body.schema || 'public') : null;
  const op = body.op;
  if (!['insert', 'update', 'delete'].includes(op)) throw U.bad('Unknown change.');
  const columns = d.type === 'postgres' ? await pg.columns(d, schema, table) : await my.columns(d, table);
  const names = new Set(columns.map((c) => c.name));
  const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (!names.has(k)) throw U.bad(`Unknown column "${k}".`);
      out[k] = asText(v);
    }
    return out;
  };
  const values = clean(body.values);
  let key = {};
  if (op !== 'insert') {
    const pk = columns.filter((c) => c.pk);
    if (!pk.length) throw U.bad('This table has no primary key, so rows can only be changed with SQL.');
    key = clean(body.key);
    for (const c of pk) if (!(c.name in key)) throw U.bad('Missing primary key value.');
    for (const k of Object.keys(key)) if (!pk.some((c) => c.name === k)) delete key[k];
    if (op === 'update' && !Object.keys(values).length) return { changed: 0 };
  }
  const changed = d.type === 'postgres'
    ? await pg.write(d, schema, table, op, columns, key, values)
    : await my.write(d, table, op, columns, key, values);
  if (op !== 'insert' && changed === 0) throw new U.HttpError(409, 'That row no longer exists. Reload and try again.');
  return { changed };
}

async function query(id, body) {
  const d = getDb(id);
  const sql = String(body.sql || '').trim();
  if (!sql) throw U.bad('Type a query.');
  if (d.type === 'redis') return rd.command(d, sql);
  return d.type === 'postgres' ? pg.query(d, sql) : my.query(d, sql);
}

// Redis
const redisDb = (id) => { const d = getDb(id); if (d.type !== 'redis') throw U.bad('Not a Redis database.'); return d; };
const keyName = (v) => { const s = String(v ?? ''); if (!s) throw U.bad('Enter a key name.'); return s; };
async function redisKeys(id, q) { return rd.keys(redisDb(id), String(q.get('match') || '*'), String(q.get('cursor') || '0')); }
async function redisGet(id, q) { return rd.get(redisDb(id), keyName(q.get('key'))); }
/** body: { key, op: set|hset|hdel|del, value?, field?, ttl? } */
async function redisWrite(id, body) {
  const d = redisDb(id);
  const key = keyName(body.key);
  if (body.op === 'set') {
    const ttl = body.ttl ? Math.floor(Number(body.ttl)) : 0;
    if (ttl < 0 || !Number.isFinite(ttl)) throw U.bad('TTL must be a positive number of seconds.');
    await rd.setString(d, key, String(body.value ?? ''), ttl);
  } else if (body.op === 'hset') await rd.hashSet(d, key, keyName(body.field), String(body.value ?? ''));
  else if (body.op === 'hdel') await rd.hashDel(d, key, keyName(body.field));
  else if (body.op === 'del') await rd.del(d, key);
  else throw U.bad('Unknown change.');
  return { ok: true };
}

module.exports = { tables, rows, write, query, redisKeys, redisGet, redisWrite, _test: { parseCsv, resultFromCsv, resultFromXml, splitArgs, parseReply } };
