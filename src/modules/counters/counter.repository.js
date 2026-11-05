import Counter from '../../models/Counter.js';

export const counterRepository = {
  /**
   * Atomically increments and returns the next value. Call this OUTSIDE a transaction where possible:
   * inside one, a rollback also rolls back the increment, and concurrent callers serialize on this document.
   * Gaps in numbering are acceptable; duplicates are not.
   */
  next: async (key, { session } = {}) => {
    const doc = await Counter.findByIdAndUpdate(key, { $inc: { seq: 1 } }, { new: true, upsert: true, session });
    return doc.seq;
  },
};
