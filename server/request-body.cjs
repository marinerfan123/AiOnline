'use strict';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function payloadTooLarge(maxBytes) {
  const error = new Error(`Request payload exceeds ${maxBytes} bytes`);
  error.code = 'PAYLOAD_TOO_LARGE';
  error.statusCode = 413;
  return error;
}

function parseJsonBody(req, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    }

    function onData(chunk) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(payloadTooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      if (totalBytes === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')));
      } catch {
        resolve(null);
      }
    }

    function onError(error) { fail(error); }
    function onAborted() {
      const error = new Error('Request aborted');
      error.code = 'REQUEST_ABORTED';
      fail(error);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

module.exports = { DEFAULT_MAX_BYTES, parseJsonBody };
