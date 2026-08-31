'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEFAULT_FILE = path.join(__dirname, 'migration-reservations.json');
const ORPHAN_TTL_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 5000;

function reservationFile() { return path.resolve(process.env.MIGRATION_RESERVATION_FILE || DEFAULT_FILE); }
function emptyRegistry() { return { versioned: {}, metadata: { lastReclaimedAt: null } }; }
function loadReservations(file = reservationFile()) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && value.versioned ? value : emptyRegistry(); }
  catch (error) { if (error.code === 'ENOENT') return emptyRegistry(); throw new Error(`Reservation registry is unreadable: ${error.message}`); }
}
function saveReservations(data, file = reservationFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(operation) {
  const file = reservationFile();
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for migration reservation lock: ${lock}`);
      sleep(10);
    }
  }
  try { return operation(file); } finally { fs.rmdirSync(lock); }
}
function cleanupOrphans(reservations, now = Date.now()) {
  let changed = false;
  for (const [version, entry] of Object.entries(reservations.versioned || {})) {
    if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) { delete reservations.versioned[version]; changed = true; }
  }
  if (changed) reservations.metadata = { ...(reservations.metadata || {}), lastReclaimedAt: new Date(now).toISOString() };
  return changed;
}
function validate(version, worktreeId, reason = '') {
  if (!/^\d{4}$/.test(version || '')) return `Invalid version format: ${version}. Must be four digits.`;
  if (!worktreeId || worktreeId === 'unknown') return 'A stable, non-unknown worktree id is required.';
  if (!reason.trim()) return 'A reservation reason is required.';
  return null;
}
function acquire(version, worktreeId, reason) {
  const invalid = validate(version, worktreeId, reason); if (invalid) return { acquired: false, version, reason: invalid };
  const inv = require('./migration-inventory.cjs');
  const inventory = inv.buildInventory();
  if (version !== inventory.nextVersion) return { acquired: false, version, reason: `Version ${version} is not available. Next P1 version is ${inventory.nextVersion}; head is ${inventory.headVersion}.`, headVersion: inventory.headVersion, nextVersion: inventory.nextVersion };
  return withLock(file => {
    const registry = loadReservations(file); cleanupOrphans(registry);
    const existing = registry.versioned[version];
    if (existing) return { acquired: false, version, reason: `Version ${version} is already reserved by worktree "${existing.holder}".`, holder: existing.holder, expiresAt: existing.expiresAt };
    const now = Date.now(); const entry = { holder: worktreeId, reason, acquiredAt: new Date(now).toISOString(), expiresAt: now + ORPHAN_TTL_MS };
    registry.versioned[version] = entry; saveReservations(registry, file);
    return { acquired: true, version, ...entry };
  });
}
function release(version, worktreeId) {
  return withLock(file => { const registry = loadReservations(file); cleanupOrphans(registry); const entry = registry.versioned[version];
    if (!entry) return { released: false, reason: `No reservation found for version ${version}.` };
    if (entry.holder !== worktreeId) return { released: false, reason: `Version ${version} is held by "${entry.holder}", not "${worktreeId}".`, holder: entry.holder };
    delete registry.versioned[version]; saveReservations(registry, file); return { released: true, version, holder: worktreeId }; });
}
function verifyReservation(version, worktreeId) {
  return withLock(file => { const registry = loadReservations(file); const changed = cleanupOrphans(registry); if (changed) saveReservations(registry, file); const entry = registry.versioned[version];
    if (!entry) return { valid: false, reason: `No active reservation for version ${version}.` };
    if (entry.holder !== worktreeId) return { valid: false, reason: `Version ${version} reserved by "${entry.holder}", not "${worktreeId}".`, holder: entry.holder };
    return { valid: true, version, holder: entry.holder, expiresAt: entry.expiresAt }; });
}
function listReservations() { return withLock(file => { const registry = loadReservations(file); const changed = cleanupOrphans(registry); if (changed) saveReservations(registry, file); return Object.entries(registry.versioned).map(([version, entry]) => ({ version, ...entry })); }); }

function main() {
  const [cmd, version, suppliedId, ...words] = process.argv.slice(2); const id = suppliedId || process.env.GIT_WORKTREE || 'unknown'; let result;
  if (cmd === 'acquire') result = acquire(version, id, words.join(' ') || '');
  else if (cmd === 'release') result = release(version, id);
  else if (cmd === 'verify') result = verifyReservation(version, id);
  else if (cmd === 'list') result = listReservations();
  else if (cmd === 'status') result = { ...require('./migration-inventory.cjs').buildInventory(), reservations: listReservations() };
  else { console.error('Usage: migration-allocator.cjs <acquire|release|verify|list|status>'); process.exit(1); }
  console.log(JSON.stringify(result, null, 2));
  if (result && (result.acquired === false || result.released === false || result.valid === false)) process.exit(1);
}
if (require.main === module) main();
module.exports = { acquire, release, verifyReservation, listReservations, cleanupOrphans, loadReservations };
