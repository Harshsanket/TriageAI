import { buildApp } from './app.js';
import { formatBootFailure } from './platform/bootFailure.js';
import { config } from './platform/config.js';
import { logger } from './platform/logger.js';
import { installProcessGuards } from './platform/process.js';

async function main(): Promise<void> {
  const removeGuards = installProcessGuards({ logger });
  process.on('exit', removeGuards);

  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp();
  } catch (err) {
    logger.fatal({ err }, formatBootFailure(err));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    process.exit(1);
  }
  const kernel = app.kernel;

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info(
      { modules: kernel?.modules, queue: kernel?.config.queue.adapter },
      `api listening on :${config.port}`,
    );
  } catch (err) {
    logger.error(err, formatBootFailure(err));
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
