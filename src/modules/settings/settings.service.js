import { env } from '../../config/environment.js';
import { settingsRepository } from './settings.repository.js';

export const settingsService = {
  /** Hotel-wide configuration. Creates it from environment defaults the first time. */
  get: (opts) => settingsRepository.getOrCreate({ timezone: env.HOTEL_TIMEZONE, currency: env.HOTEL_CURRENCY }, opts),
};
