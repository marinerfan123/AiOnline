'use strict';
/**
 * Migration Allocator & Registry — ensures one worktree = one writer.
 *
 * Mechanism:
 *   1. reservation.json — shared state file tracking in-progress allocations
 *   2. acquire(version, worktreeId, reason) — claims a version slot
 *   3. release(version, worktreeId) — releases the slot when done
 *   4. verifyReservation(version, worktreeId) — CI gate checks
 *
 * Safety invariants:
 *   - No two writers can acquire the same version simultaneously
 *   - Orphaned reservations (stale worktreeId) expire after TTL
 *   - Versions must be contiguous from head — no skipping
 */

const fs = require('fs');
const path = require('path');

const RESERVATION_FILE = path.join(__dirname, 'migration-reservations.json');
const ORPHAN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Reservation file helpers ────────────────────────────────────────────────

function loadReservations() {
  try {
    const raw = fs.readFileSync(RESERVATION_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { versioned: {}, metadata: { lastReclaimedAt: null } };
  }
}

function saveReservations(data) {
  fs.writeFileSync(RESERVATION_FILE, JSON.stringify(data, null, 2) + '\n');
}

function cleanupOrphans(reservations) {
  const now = Date.now();
  let changed = false;
  for (const [ver, entry] of Object.entries(reservations.versioned)) {
    if (entry.expiresAt < now) {
      delete reservations.versioned[ver];
      changed = true;
    }
  }
  if (changed) {
    reservations.metadata.lastReclaimedAt = new Date().toISOString();
    saveReservations(reservations);
  }
  return reservations;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Acquire a version reservation.
 * @param {string} version   - e.g. '0017'
 * @param {string} worktreeId - e.g. 'p1-g0-04-migration-governance'
 * @param {string} reason    - human-readable purpose
 * @returns {{ acquired: boolean, version: string, holder: string, expiresAt: number }}
 */
function acquire(version, worktreeId, reason) {
  const inv = require('./migration-inventory.cjs');
  const migrations = inv.discoverMigrations();
  const head = inv.getHeadVersion(migrations);
  const next = inv.getNextVersion(migrations);

  // Guard: version must be next available
  if (version !== next) {
    return {
      acquired: false,
      version,
      reason: `Version ${version} is not available. Next version is ${next}. Head is ${head}.`,
      headVersion: head,
      nextVersion: next,
    };
  }

  // Guard: version must match alphanumeric pattern
  if (!/^\d{4}$/.test(version)) {
    return {
      acquired: false,
      version,
      reason: `Invalid version format: ${version}. Must be 4-digit number (e.g. 0017).`,
    };
  }

  let reservations = cleanupOrphans(loadReservations());

  // Guard: version not already held
  if (reservations.versioned[version]) {
    const existing = reservations.versioned[version];
    return {
      acquired: false,
      version,
      reason: `Version ${version} is already reserved by worktree "${existing.holder}". Reason: ${existing.reason}. Expires: ${new Date(existing.expiresAt).toISOString()}.`,
      holder: existing.holder,
      expiresAt: existing.expiresAt,
    };
  }

  // Claim the slot
  reservations.versioned[version] = {
    holder: worktreeId,
    reason,
    acquiredAt: new Date().toISOString(),
    expiresAt: Date.now() + ORPHAN_TTL_MS,
  };
  saveReservations(reservations);

  return {
    acquired: true,
    version,
    holder: worktreeId,
    reason,
    expiresAt: Date.now() + ORPHAN_TTL_MS,
  };
}

/**
 * Release a version reservation.
 */
function release(version, worktreeId) {
  let reservations = loadReservations();
  const entry = reservations.versioned?.[version];

  if (!entry) {
    return { released: false, reason: `No reservation found for version ${version}.` };
  }
  if (entry.holder !== worktreeId) {
    return {
      released: false,
      reason: `Version ${version} is held by "${entry.holder}", not "${worktreeId}". Cannot release.`,
      holder: entry.holder,
    };
  }

  delete reservations.versioned[version];
  saveReservations(reservations);
  return { released: true, version, holder: worktreeId };
}

/**
 * Check if a version has a valid reservation.
 * Used by CI gate.
 */
function verifyReservation(version, worktreeId) {
  const reservations = cleanupOrphans(loadReservations());
  const entry = reservations.versioned?.[version];

  if (!entry) {
    return { valid: false, reason: `No active reservation for version ${version}.` };
  }
  if (entry.holder !== worktreeId) {
    return {
      valid: false,
      reason: `Version ${version} reserved by "${entry.holder}", not "${worktreeId}".`,
      holder: entry.holder,
    };
  }
  return { valid: true, version, holder: entry.holder, expiresAt: entry.expiresAt };
}

/**
 * List all active reservations.
 */
function listReservations() {
  const reservations = cleanupOrphans(loadReservations());
  return Object.entries(reservations.versioned ?? {}).map(([version, entry]) => ({
    version,
    ...entry,
  }));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'acquire') {
    const version = args[1];
    const worktreeId = args[2] || process.env.GIT_WORKTREE || 'unknown';
    const reason = args.slice(3).join(' ') || 'migration allocation';
    const result = acquire(version, worktreeId, reason);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.acquired ? 0 : 1);
  }

  if (cmd === 'release') {
    const version = args[1];
    const worktreeId = args[2] || process.env.GIT_WORKTREE || 'unknown';
    const result = release(version, worktreeId);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.released ? 0 : 1);
  }

  if (cmd === 'verify') {
    const version = args[1];
    const worktreeId = args[2] || process.env.GIT_WORKTREE || 'unknown';
    const result = verifyReservation(version, worktreeId);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  }

  if (cmd === 'list') {
    console.log(JSON.stringify(listReservations(), null, 2));
    return;
  }

  if (cmd === 'status') {
    const inv = require('./migration-inventory.cjs');
    const migrations = inv.discoverMigrations();
    const head = inv.getHeadVersion(migrations);
    const next = inv.getNextVersion(migrations);
    const reservations = listReservations();
    console.log(`Head: ${head}`);
    console.log(`Next: ${next}`);
    console.log(`Migrations: ${migrations.length}`);
    console.log(`Active reservations: ${reservations.length}`);
    for (const r of reservations) {
      console.log(`  ${r.version} → ${r.holder} (${r.reason})`);
    }
    return;
  }

  console.error('Usage: migration-allocator.cjs <acquire|release|verify|list|status> [args...]');
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { acquire, release, verifyReservation, listReservations, cleanupOrphans };
