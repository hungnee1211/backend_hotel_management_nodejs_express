import Guest from '../../models/Guest.js';

const alive = { deletedAt: null };

export const guestRepository = {
  create: async (data) => (await Guest.create([data]))[0],

  /** `withSecrets` also loads the encrypted ID number (only for the explicit "reveal" action). */
  findById: (id, { withSecrets = false } = {}) => {
    const q = Guest.findOne({ _id: id, ...alive });
    return withSecrets ? q.select('+identification.numberEncrypted') : q;
  },

  findByNumberHash: (numberHash) => Guest.findOne({ 'identification.numberHash': numberHash, ...alive }).select('_id fullName').lean(),

  updateById: (id, update) => Guest.findOneAndUpdate({ _id: id, ...alive }, update, { new: true, runValidators: true }),

  list: async (filter, { skip, limit, sort }) => {
    const query = { ...alive, ...filter };
    const [items, total] = await Promise.all([
      Guest.find(query).sort(sort).skip(skip).limit(limit),
      Guest.countDocuments(query),
    ]);
    return { items, total };
  },
};
