import { staffRepository } from './staff.repository.js';

/**
 * Read-only "who reports to whom" lookups. Other modules (users, later bookings/housekeeping)
 * depend on this instead of reaching into the staff repository, and it imports nothing from them,
 * which keeps the module graph free of cycles.
 */
export const staffScopeService = {
  findProfile: (userId) => staffRepository.findProfileByUserId(userId),
  listManagedUserIds: (managerId) => staffRepository.listUserIdsByManager(managerId),
  countActiveReports: (managerId) => staffRepository.countActiveReports(managerId),
};
