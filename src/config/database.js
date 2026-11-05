import mongoose from 'mongoose';
import { env } from './environment.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);

let transactionsSupported = false;
export const supportsTransactions = () => transactionsSupported;

export const connectDatabase = async () => {
  await mongoose.connect(env.MONGODB_URI, {
    // In production build indexes explicitly with `yarn db:sync-indexes` during deploys.
    autoIndex: !env.isProd,
    serverSelectionTimeoutMS: 10_000,
  });

  // Multi-document transactions only work on replica sets and sharded clusters.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  transactionsSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid';

  if (!transactionsSupported) {
    if (!env.ALLOW_STANDALONE_MONGO) {
      await mongoose.disconnect();
      throw new Error(
        'MongoDB is running standalone, but this system needs transactions (replica set). ' +
          'Run `docker compose up -d` and use the replicaSet connection string, ' +
          'or set ALLOW_STANDALONE_MONGO=true for non-transactional development only.',
      );
    }
    logger.warn('Standalone MongoDB: transactions are DISABLED. Booking and billing workflows will fail.');
  }
  logger.info('MongoDB connected', { replicaSet: hello.setName ?? null, transactions: transactionsSupported });
};

export const disconnectDatabase = () => mongoose.disconnect();
