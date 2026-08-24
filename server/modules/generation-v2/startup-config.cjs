'use strict';
const fs = require('fs');

class StartupConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StartupConfigError';
    this.code = 'GENERATION_V2_STARTUP_CONFIG_INVALID';
    this.details = details;
  }
}

function parseBoolean(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new StartupConfigError(`${name} must be true or false`, { field: name });
}

function readJsonConfigFile(filePath, { required = false, label = 'configuration' } = {}) {
  if (!filePath) {
    if (required) throw new StartupConfigError(`${label} file path is required`, { path: filePath });
    return {};
  }
  if (!fs.existsSync(filePath)) {
    if (required) throw new StartupConfigError(`${label} file is missing`, { path: filePath });
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim() === '') {
    throw new StartupConfigError(`${label} file is empty`, { path: filePath });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StartupConfigError(`${label} file must contain a JSON object`, { path: filePath });
    }
    return parsed;
  } catch (err) {
    if (err instanceof StartupConfigError) throw err;
    throw new StartupConfigError(`${label} file contains malformed JSON`, { path: filePath, cause: err.message });
  }
}

function loadWorkerStartupConfig(env = process.env) {
  const enabled = parseBoolean(env.GENERATION_V2_WORKER_ENABLED, 'GENERATION_V2_WORKER_ENABLED') === true;
  if (!enabled) return { enabled: false, evidence: {} };

  const evidencePath = env.GENERATION_V2_EVIDENCE_FILE;
  const evidence = readJsonConfigFile(evidencePath, { required: true, label: 'Generation V2 evidence' });

  return {
    enabled: true,
    evidencePath,
    evidence,
  };
}

module.exports = { StartupConfigError, readJsonConfigFile, loadWorkerStartupConfig };
