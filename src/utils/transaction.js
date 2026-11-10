import mongoose from 'mongoose';
import { supportsTransactions } from '../config/database.js';
import { ApiError } from './ApiError.js';

/**
 * Runs `work(session)` inside a MongoDB transaction and commits atomically.
 * Mongo may RETRY `work` on transient errors, so keep it free of side effects
 * outside the database (no emails, no payment-provider calls) and pass `{ session }`
 * to every repository call inside it.
 */
export const withTransaction = async (work) => {
  if (!supportsTransactions()) {
    throw new ApiError(500, 'Transactions are not available on this database', 'TRANSACTIONS_UNAVAILABLE');
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
};
