import { counterRepository } from './counter.repository.js';

export const counterService = {
  /** Next value of a named sequence (see counterRepository.next for the transaction caveat). */
  next: (key, opts) => counterRepository.next(key, opts),
  /** e.g. formatted('employee', 'EMP', 5) -> "EMP-00007" */
  async formatted(key, prefix, width = 5, opts) {
    return `${prefix}-${String(await counterRepository.next(key, opts)).padStart(width, '0')}`;
  },
};
