'use strict';

function createSingleFlight(fn) {
  let running = false;
  return async function runSingleFlight(...args) {
    if (running) return { skipped: true };
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}

module.exports = { createSingleFlight };
