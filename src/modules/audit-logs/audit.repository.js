import AuditLog from '../../models/AuditLog.js';

export const auditRepository = {
  create: async (data) => (await AuditLog.create([data]))[0],
};
