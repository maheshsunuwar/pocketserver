'use strict';
// All PocketServer state lives in one JSON file (~/.pocketserver/state.json), written atomically.
const fs = require('fs');
const { paths } = require('./util');

const state = { apps: {}, databases: {}, settings: {}, sessions: {}, pids: {} };
try {
  Object.assign(state, JSON.parse(fs.readFileSync(paths.state, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Could not read state file, starting fresh:', e.message);
}

let timer = null;
function flush() {
  clearTimeout(timer);
  timer = null;
  const tmp = paths.state + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.state);
}
function save() {
  if (!timer) timer = setTimeout(flush, 250);
}

module.exports = { state, save, flush };
