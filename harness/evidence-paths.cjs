'use strict';

const os = require('os');
const path = require('path');

// Generated evidence is runtime output. Tracked harness/evidence files are fixtures.
const DEFAULT_EVIDENCE_DIR = path.join(os.tmpdir(), 'moling-golden-path', String(process.pid));

module.exports = { DEFAULT_EVIDENCE_DIR };
