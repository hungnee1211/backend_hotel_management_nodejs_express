import mongoose from 'mongoose';
import { env } from '../../src/config/environment.js';

/** True only when a replica set is reachable, so DB-backed suites can skip themselves cleanly. */
export const isDbAvailable = async () => {
  try {
    const conn = await mongoose.createConnection(env.MONGODB_URI, { serverSelectionTimeoutMS: 1500 }).asPromise();
    const hello = await conn.db.admin().command({ hello: 1 });
    await conn.close();
    return Boolean(hello.setName);
  } catch {
    return false;
  }
};
