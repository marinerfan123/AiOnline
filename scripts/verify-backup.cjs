'use strict';
/**
 * Backup verification command — Moling AI
 *
 * Verifies backup integrity:
 * - manifest.json exists and is valid JSON
 * - All listed files exist
 * - SHA256 checksums match
 * - Backup data is readable
 * - pg_dump archives are readable (if pg_dump available)
 *
 * Usage:
 *   node scripts/verify-backup.cjs <backup_dir>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function verify(backupDir) {
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(backupDir)) {
    console.error(`FAIL: backup directory does not exist: ${backupDir}`);
    process.exit(1);
    return;
  }

  // 1. Check manifest
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    errors.push('Missing manifest.json');
  } else {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      console.log(`OK: manifest.json valid (backup_id: ${manifest.backup_id || 'unknown'})`);

      // Check required fields
      const required = ['backup_id', 'timestamp', 'database_name', 'backup_format'];
      for (const field of required) {
        if (!(field in manifest)) {
          warnings.push(`Manifest missing field: ${field}`);
        }
      }

      // Check secret_present
      if (manifest.secret_present) {
        errors.push('CRITICAL: manifest reports secret_present=true — backup may contain secrets!');
      }

      // Verify files listed in manifest
      if (manifest.files_included) {
        for (const file of manifest.files_included) {
          const filePath = path.join(backupDir, file);
          if (!fs.existsSync(filePath)) {
            errors.push(`File from manifest missing: ${file}`);
          } else {
            console.log(`OK: ${file} exists (${fs.statSync(filePath).size} bytes)`);
          }
        }
      }
    } catch (err) {
      errors.push(`Invalid manifest.json: ${err.message}`);
    }
  }

  // 2. Verify checksums
  const checksumPath = path.join(backupDir, 'checksums.sha256');
  if (fs.existsSync(checksumPath)) {
    const checksumLines = fs.readFileSync(checksumPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim());

    let checksumsPassed = 0;
    let checksumsFailed = 0;

    for (const line of checksumLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const expectedHash = parts[0];
      const filename = parts[1];
      const filePath = path.join(backupDir, filename);

      if (!fs.existsSync(filePath)) {
        errors.push(`Checksum file missing: ${filename}`);
        checksumsFailed++;
        continue;
      }

      const actualHash = crypto.createHash('sha256')
        .update(fs.readFileSync(filePath))
        .digest('hex');

      if (actualHash === expectedHash) {
        console.log(`OK: ${filename} checksum verified`);
        checksumsPassed++;
      } else {
        errors.push(`CHECKSUM MISMATCH: ${filename}`);
        checksumsFailed++;
      }
    }

    console.log(`Checksums: ${checksumsPassed} passed, ${checksumsFailed} failed`);
  } else {
    warnings.push('No checksums.sha256 file found');
  }

  // 3. Verify data file is readable
  const schemaMetaPath = path.join(backupDir, 'schema-meta.json');
  if (fs.existsSync(schemaMetaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(schemaMetaPath, 'utf-8'));
      const tables = Object.keys(meta);
      console.log(`OK: schema-meta.json contains ${tables} tables`);
    } catch (err) {
      errors.push(`schema-meta.json is not valid JSON: ${err.message}`);
    }
  } else {
    warnings.push('No schema-meta.json file found (may be pg_dump format)');
  }

  const dataPath = path.join(backupDir, 'data.json');
  if (fs.existsSync(dataPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      const tables = Object.keys(data);
      let totalRows = 0;
      for (const table of tables) {
        totalRows += data[table].length;
      }
      console.log(`OK: data.json contains ${tables} tables, ${totalRows} total rows`);
    } catch (err) {
      errors.push(`data.json is not valid JSON: ${err.message}`);
    }
  } else {
    warnings.push('No data.json file found (may be pg_dump format)');
  }

  // 4. Verify pg_dump archive if present
  const dumpPath = path.join(backupDir, 'backup.dump');
  if (fs.existsSync(dumpPath)) {
    const { spawnSync } = require('child_process');
    const listResult = spawnSync('pg_restore', ['--list', dumpPath], { encoding: 'utf-8' });
    if (listResult.status === 0) {
      console.log('OK: backup.dump is a valid pg_dump custom archive');
    } else {
      errors.push('pg_restore --list failed — backup.dump may be corrupted');
    }
  }

  // Summary
  console.log('');
  console.log('=== VERIFICATION SUMMARY ===');
  if (errors.length === 0 && warnings.length === 0) {
    console.log('RESULT: PASS');
  } else {
    if (warnings.length > 0) {
      console.log(`Warnings: ${warnings.length}`);
      for (const w of warnings) {
        console.log(`  WARN: ${w}`);
      }
    }
    if (errors.length > 0) {
      console.log(`Errors: ${errors.length}`);
      for (const e of errors) {
        console.log(`  FAIL: ${e}`);
      }
      console.log('RESULT: FAIL');
      process.exit(1);
    } else {
      console.log('RESULT: PASS (with warnings)');
    }
  }
}

const backupDir = process.argv[2];
if (!backupDir) {
  console.error('Usage: node verify-backup.cjs <backup_directory>');
  process.exit(1);
}

verify(backupDir);
