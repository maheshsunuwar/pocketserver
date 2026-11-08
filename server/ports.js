'use strict';
const { state } = require('./store');
const { portFree, bad } = require('./util');

function usedPorts(exceptId) {
  const used = new Set([Number(process.env.POCKETSERVER_PORT || state.settings.port) || 7777]);
  for (const a of Object.values(state.apps)) if (a.id !== exceptId && a.port) used.add(a.port);
  for (const d of Object.values(state.databases)) if (d.id !== exceptId && d.port) used.add(d.port);
  if (exceptId !== 'sshd' && state.settings.ssh && state.settings.ssh.port) used.add(state.settings.ssh.port);
  return used;
}

/** Picks a free port, starting from `from`. */
async function allocate(from = 3001, exceptId) {
  const used = usedPorts(exceptId);
  for (let p = from; p < 65535; p++) {
    if (!used.has(p) && await portFree(p)) return p;
  }
  throw new Error('No free port found.');
}

function validate(port, exceptId) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw bad('Port must be a number between 1024 and 65535.');
  if (usedPorts(exceptId).has(p)) throw bad(`Port ${p} is already used by PocketServer or another app.`);
  return p;
}

module.exports = { allocate, validate };
