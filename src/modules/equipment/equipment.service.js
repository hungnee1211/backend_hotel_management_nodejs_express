import mongoose from 'mongoose';
import AuditLog from '../../models/AuditLog.js';
import Equipment from '../../models/Equipment.js';
import MaintenanceHistory from '../../models/MaintenanceHistory.js';
import MaintenanceRequest from '../../models/MaintenanceRequest.js';
import { EQUIPMENT_STATUS as E } from '../../constants/index.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';
import { counterService } from '../counters/counter.service.js';
import { facilityService } from '../facilities/facility.service.js';

const OPEN = ['PENDING', 'ASSIGNED', 'IN_PROGRESS'];
const load = async (id) => { const e = mongoose.isValidObjectId(id) ? await Equipment.findOne({ _id: id, deletedAt: null }) : null; if (!e) throw ApiError.notFound('Equipment not found', 'EQUIPMENT_NOT_FOUND'); return e; };

export const equipmentService = {
  async create(caller, data, ctx) {
    await facilityService.loadManageable(caller, data.facilityId); // managers: only their own facilities
    const equipmentCode = await counterService.formatted('equipment', 'EQ', 5);
    const nextMaintenanceAt = data.nextMaintenanceAt ?? (data.maintenanceIntervalDays ? new Date(Date.now() + data.maintenanceIntervalDays * 86_400_000) : undefined);
    const e = await Equipment.create({ ...data, equipmentCode, nextMaintenanceAt });
    await auditService.log(caller.user, ctx, 'EQUIPMENT_CREATED', 'Equipment', e._id, { after: e });
    return e.toJSON();
  },

  async list(q) {
    const filter = { deletedAt: null };
    for (const k of ['facilityId', 'status', 'category']) if (q[k]) filter[k] = q[k];
    if (q.search) { const rx = new RegExp(escapeRegex(q.search), 'i'); filter.$or = [{ name: rx }, { equipmentCode: rx }, { brand: rx }, { model: rx }]; }
    if (q.warrantyExpiringDays !== undefined) filter.warrantyExpiration = { $gte: new Date(), $lte: new Date(Date.now() + q.warrantyExpiringDays * 86_400_000) };
    if (q.maintenanceDueDays !== undefined) filter.nextMaintenanceAt = { $lte: new Date(Date.now() + q.maintenanceDueDays * 86_400_000) };
    const paging = parsePagination(q, { allowedSort: ['name', 'equipmentCode', 'nextMaintenanceAt', 'createdAt'], defaultSort: 'createdAt' });
    const [items, total] = await Promise.all([Equipment.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Equipment.countDocuments(filter)]);
    return { items: items.map((e) => e.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },

  async get(id) {
    const e = await load(id);
    const history = await MaintenanceHistory.find({ equipmentId: id }).sort({ maintenanceDate: -1 }).limit(20);
    return { ...e.toJSON(), maintenanceHistory: history.map((h) => h.toJSON()) };
  },

  /** Full change trail: field edits (audit log) and every completed repair. */
  async history(id) {
    await load(id);
    const [audit, repairs] = await Promise.all([AuditLog.find({ resourceType: 'Equipment', resourceId: id }).sort({ createdAt: -1 }).limit(100).lean(), MaintenanceHistory.find({ equipmentId: id }).sort({ maintenanceDate: -1 })]);
    return { audit, repairs: repairs.map((r) => r.toJSON()) };
  },

  async update(caller, id, patch, ctx) {
    const before = await load(id);
    await facilityService.loadManageable(caller, before.facilityId);
    if (before.status === E.RETIRED) throw ApiError.conflict('Retired equipment cannot be changed', 'EQUIPMENT_RETIRED');
    if (patch.facilityId && String(patch.facilityId) !== String(before.facilityId)) await facilityService.loadManageable(caller, patch.facilityId);
    if (patch.status === E.RETIRED && (await MaintenanceRequest.exists({ equipmentId: id, status: { $in: OPEN } }))) throw ApiError.conflict('Close the open maintenance requests first', 'EQUIPMENT_IN_USE');
    const after = await Equipment.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await auditService.log(caller.user, ctx, 'EQUIPMENT_UPDATED', 'Equipment', id, { before, after });
    return after.toJSON();
  },

  retire: (caller, id, ctx) => equipmentService.update(caller, id, { status: E.RETIRED }, ctx),
};
