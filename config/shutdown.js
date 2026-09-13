// config/shutdown.js — graceful shutdown coordinator.
//
// On SIGTERM/SIGINT: stop accepting new requests (server.close), drain in-flight
// connections for a bounded period, close the database pool, then exit so the
// process supervisor (systemd) can restart cleanly. A hard timeout forces exit
// if graceful draining hangs.
'use strict';

/**
 * Install graceful shutdown handlers on the process.
 * @param {import('http').Server} server - the HTTP server.
 * @param {object} [opts]
 * @param {object} [opts.pool] - mysql2 pool with an `end()` method.
 * @param {number} [opts.timeoutMs] - max graceful-drain time (default 10s).
 * @param {object} [opts.logger] - logger with error() (default console).
 * @returns {Function} the shutdown(signal) function (also used for tests).
 */
function installGracefulShutdown(server, { pool, timeoutMs = 10000, logger = console } = {}) {
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.error(`[SHUTDOWN] Received ${signal}. Draining connections...`);

    const forceTimer = setTimeout(() => {
      logger.error(`[SHUTDOWN] Graceful shutdown timed out after ${timeoutMs}ms; forcing exit.`);
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    server.close(async (closeErr) => {
      try {
        if (pool && typeof pool.end === 'function') {
          logger.error('[SHUTDOWN] Closing database pool...');
          await pool.end();
        }
      } catch (e) {
        logger.error(`[SHUTDOWN] Error closing db pool: ${e && e.message}`);
      }
      clearTimeout(forceTimer);
      logger.error(`[SHUTDOWN] Exiting (${closeErr ? 'with error' : 'clean'}).`);
      process.exit(closeErr ? 1 : 0);
    });

    // Stop keep-alive connections so the server closes promptly.
    if (typeof server.closeIdleConnections === 'function') {
      setImmediate(() => { try { server.closeIdleConnections(); } catch (e) { /* ignore */ } });
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return shutdown;
}

module.exports = { installGracefulShutdown };
