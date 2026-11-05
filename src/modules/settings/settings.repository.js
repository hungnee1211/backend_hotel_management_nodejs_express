import Settings from '../../models/Settings.js';

export const settingsRepository = {
  /** Returns the hotel settings, creating them from `defaults` on first use (race-safe via upsert). */
  getOrCreate: (defaults, { session } = {}) =>
    Settings.findOneAndUpdate(
      { key: 'hotel' },
      { $setOnInsert: { key: 'hotel', ...defaults } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true, session },
    ).lean(),
};
