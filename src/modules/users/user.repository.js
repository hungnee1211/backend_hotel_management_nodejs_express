import User from '../../models/User.js';
import { identifierQuery } from '../../utils/identifier.js';

const alive = { deletedAt: null };

export const userRepository = {
  create: async (data, { session } = {}) => (await User.create([data], { session }))[0],

  findById: (id) => User.findOne({ _id: id, ...alive }),
  findByIdWithPassword: (id) => User.findOne({ _id: id, ...alive }).select('+password'),
  findByIdentifier: (identifier) => User.findOne({ ...identifierQuery(identifier), ...alive }),
  findByIdentifierWithPassword: (identifier) =>
    User.findOne({ ...identifierQuery(identifier), ...alive }).select('+password'),

  /** Includes soft-deleted users: their email/phone stay reserved. */
  findDuplicate: ({ email, phone }, { session } = {}) => {
    const or = [];
    if (email) or.push({ email });
    if (phone) or.push({ phone });
    return or.length ? User.findOne({ $or: or }).select('_id').session(session ?? null).lean() : null;
  },

  /** `update` is a Mongo update document, e.g. { $set: {...}, $inc: {...} }. */
  updateById: (id, update, { session } = {}) =>
    User.findOneAndUpdate({ _id: id, ...alive }, update, { new: true, runValidators: true, session }),

  list: async (filter, { skip, limit, sort }) => {
    const query = { ...alive, ...filter };
    const [items, total] = await Promise.all([
      User.find(query).sort(sort).skip(skip).limit(limit),
      User.countDocuments(query),
    ]);
    return { items, total };
  },
};
