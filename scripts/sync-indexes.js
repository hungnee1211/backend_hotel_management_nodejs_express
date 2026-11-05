import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import * as models from '../src/models/index.js';
import { logger } from '../src/utils/logger.js';

/** Builds/updates indexes for every model. Run during deploys: `yarn db:sync-indexes`. */
try {
  await connectDatabase();
  for (const [name, model] of Object.entries(models)) {
    await model.syncIndexes();
    logger.info(`Indexes synced: ${name}`);
  }
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
