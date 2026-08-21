'use strict';

function createWorkerDaemon(opts = {}) {
  const {
    workerId, tick, pgPool, redis,
    tickIntervalMs = 1000,
    gracefulShutdownMs = 30000,
    onError = (e) => console.error('[worker-daemon] tick error', e),
  } = opts;

  let running = false;
  let currentTick = null;
  let stopped = false;
  let resolveStop;
  const stopPromise = new Promise(r => { resolveStop = r; });

  async function loop() {
    while (!stopped) {
      const tickStart = Date.now();
      currentTick = (async () => {
        try { await tick(pgPool, redis, { workerId }); }
        catch (e) { try { onError(e); } catch (_) {} }
        finally { currentTick = null; }
      })();
      await currentTick;
      if (stopped) break;
      const elapsed = Date.now() - tickStart;
      const delay = Math.max(0, tickIntervalMs - elapsed);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
    resolveStop();
  }

  return {
    start() {
      if (!workerId) return Promise.reject(new TypeError('workerId is required'));
      if (typeof tick !== 'function') return Promise.reject(new TypeError('tick function required'));
      if (running) return Promise.resolve();
      running = true;
      return loop();
    },
    async stop() {
      stopped = true;
      const timeout = new Promise(r => setTimeout(r, gracefulShutdownMs));
      await Promise.race([stopPromise, timeout]);
    },
  };
}

module.exports = { createWorkerDaemon };
