import mongoose from 'mongoose';
import Equipment from '../../models/Equipment.js';
import Facility from '../../models/Facility.js';
import MaintenanceRequest from '../../models/MaintenanceRequest.js';
import { ROLES } from '../../constants/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { userService } from '../users/user.service.js';

const same = (a, b) => String(a) === String(b);
const checkHours = (hours = []) => {
  const days = hours.map((h) => h.day);
  if (new Set(days).size !== days.length) throw ApiError.unprocessable('Each weekday may appear once in the operating hours', [{ field: 'body.operatingHours', message: 'duplicate day' }]);
  for (const h of hours) if (h.open === h.close) throw ApiError.unprocessable('Opening and closing time must differ', [{ field: 'body.operatingHours', message: `day ${h.day}` }]);
};

export const facilityService = {
  /** Admin: any facility. Manager: only facilities they are responsible for (404 otherwise). */
  async loadManageable(caller, id) {
    const f = mongoose.isValidObjectId(id) ? await Facility.findOne({ _id: id, deletedAt: null }) : null;
    if (!f || (caller.user.role === ROLES.MANAGER && !same(f.managerId, caller.user._id))) throw ApiError.notFound('Facility not found', 'FACILITY_NOT_FOUND');
    return f;
  },
  /** Facilities a manager answers for (null = no restriction). */
  managedIds: async (caller) => (caller.user.role === ROLES.ADMIN ? null : Facility.find({ managerId: caller.user._id, deletedAt: null }).distinct('_id')),

  async create(caller, data, ctx) {
    checkHours(data.operatingHours);
    let managerId = null;
    if (caller.user.role === ROLES.MANAGER) managerId = caller.user._id; // a manager's new facility is theirs
    else if (data.managerId) { await userService.assertActiveManager(data.managerId); managerId = data.managerId; }
    const f = await Facility.create({ ...data, managerId });
    await auditService.log(caller.user, ctx, 'FACILITY_CREATED', 'Facility', f._id, { after: f });
    return f.toJSON();
  },

  async list(q) {
    const filter = { deletedAt: null };
    for (const k of ['type', 'status', 'managerId']) if (q[k]) filter[k] = q[k];
    if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');
    const paging = parsePagination(q, { allowedSort: ['name', 'createdAt'], defaultSort: 'name', defaultLimit: 50 });
    const [items, total] = await Promise.all([Facility.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Facility.countDocuments(filter)]);
    return { items: items.map((f) => f.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(id) {
    const f = mongoose.isValidObjectId(id) ? await Facility.findOne({ _id: id, deletedAt: null }) : null;
    if (!f) throw ApiError.notFound('Facility not found', 'FACILITY_NOT_FOUND');
    const counts = await Equipment.aggregate([{ $match: { facilityId: f._id, deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    return { ...f.toJSON(), equipmentByStatus: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
  },

  async update(caller, id, patch, ctx) {
    const before = await this.loadManageable(caller, id);
    if (patch.operatingHours) checkHours(patch.operatingHours);
    if (patch.managerId !== undefined) {
      if (caller.user.role !== ROLES.ADMIN) throw ApiError.forbidden('Only Admins can reassign a facility');
      if (patch.managerId) await userService.assertActiveManager(patch.managerId);
    }
    const after = await Facility.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await auditService.log(caller.user, ctx, 'FACILITY_UPDATED', 'Facility', id, { before, after });
    return after.toJSON();
  },

  /** Deactivation hides the facility. It is refused while live equipment or open repairs depend on it. */
  async remove(caller, id, ctx) {
    const f = await this.loadManageable(caller, id);
    if (await Equipment.exists({ facilityId: id, deletedAt: null, status: { $ne: 'RETIRED' } })) throw ApiError.conflict('Retire or move the facility\'s equipment first', 'FACILITY_IN_USE');
    if (await MaintenanceRequest.exists({ facilityId: id, status: { $in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } })) throw ApiError.conflict('The facility has open maintenance requests', 'FACILITY_IN_USE');
    await Facility.updateOne({ _id: id }, { $set: { deletedAt: new Date(), status: 'CLOSED' } });
    await auditService.log(caller.user, ctx, 'FACILITY_DELETED', 'Facility', id, { before: f });
  },
};
