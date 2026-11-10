import app from './app.js';
import { env } from './config/environment.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { startJobs } from './jobs/index.js';
import { settingsService } from './modules/settings/settings.service.js';
import { logger } from './utils/logger.js';

const start = async () => {
  await connectDatabase();
  const settings = await settingsService.get(); // ensures the settings document exists
  logger.info('Hotel settings loaded', { timezone: settings.timezone, currency: settings.currency });

  const stopJobs = startJobs();
  const server = app.listen(env.PORT, () => logger.info(`API listening on port ${env.PORT} (${env.NODE_ENV})`));

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    stopJobs();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // force exit if connections hang
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.stack : reason });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { stack: err.stack });
  process.exit(1);
});

start().catch((err) => {
  logger.error(`Failed to start: ${err.message}`);
  process.exit(1);
});
