import { buildApp } from './app.js';
import { config } from './platform/config.js';
import { logger } from './platform/logger.js';

async function main(): Promise<void> {
  if (config.authMode === 'disabled' && config.nodeEnv === 'production') {
    logger.warn(
      'AUTH_MODE=disabled with NODE_ENV=production: every request is an admin. ' +
        'Only run this way on a loopback-bound port (see SETUP.md).',
    );
  }
  const app = await buildApp();
  const kernel = app.kernel;

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(
      { modules: kernel?.modules, queue: kernel?.config.queue.adapter },
      `api listening on :${config.port}`,
    );
  } catch (err) {
    logger.error(err, 'failed to start api');
    process.exit(1);
  }

  // app.close() triggers the kernel shutdown hook (drain queue, stop modules)
  // and closes the database pool.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
