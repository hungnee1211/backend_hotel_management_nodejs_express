import RoomType from '../../models/RoomType.js';
import Room from '../../models/Room.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, escapeRegex, parsePagination } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';

const assertRates = (rates = []) => {
  const sorted = [...rates].sort((a, b) => a.from.localeCompare(b.from));
  sorted.forEach((r, i) => {
    if (r.to < r.from) throw ApiError.unprocessable('Seasonal rate ends before it starts', [{ field: 'body.rates', message: `${r.from}..${r.to}` }], 'INVALID_RATE');
    if (i && sorted[i - 1].to >= r.from) throw ApiError.unprocessable('Seasonal rates must not overlap', [{ field: 'body.rates', message: `${sorted[i - 1].to} overlaps ${r.from}` }], 'RATE_OVERLAP');
  });
};
const PRICE_FIELDS = ['basePriceMinor', 'rates'];

export const roomTypeService = {
  async list(query, caller) {
    const paging = parsePagination(query, { allowedSort: ['name', 'basePriceMinor', 'capacity', 'createdAt'], defaultSort: 'name' });
    const filter = {};
    if (!caller.permissions.has(P.ROOM_MANAGE)) filter.status = 'ACTIVE'; // guests never see inactive types
    else if (query.status) filter.status = query.status;
    if (query.search) filter.name = new RegExp(escapeRegex(query.search), 'i');
    const [items, total] = await Promise.all([RoomType.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), RoomType.countDocuments(filter)]);
    return { items: items.map((t) => t.toJSON()), meta: buildPageMeta({ ...paging, total }) };
  },
  async get(id, caller) {
    const t = await RoomType.findById(id);
    if (!t || (t.status !== 'ACTIVE' && !caller.permissions.has(P.ROOM_MANAGE))) throw ApiError.notFound('Room type not found', 'ROOM_TYPE_NOT_FOUND');
    return t.toJSON();
  },
  async create(caller, data, ctx) {
    if (!caller.permissions.has(P.ROOM_PRICING_MANAGE)) throw ApiError.forbidden('You cannot set room prices');
    assertRates(data.rates);
    const t = await RoomType.create(data);
    await auditService.log(caller.user, ctx, 'ROOM_TYPE_CREATED', 'RoomType', t._id, { after: t });
    return t.toJSON();
  },
  async update(caller, id, patch, ctx) {
    if (PRICE_FIELDS.some((k) => patch[k] !== undefined) && !caller.permissions.has(P.ROOM_PRICING_MANAGE)) throw ApiError.forbidden('You cannot change room prices');
    if (patch.rates) assertRates(patch.rates);
    const before = await RoomType.findById(id);
    if (!before) throw ApiError.notFound('Room type not found', 'ROOM_TYPE_NOT_FOUND');
    if (patch.status === 'INACTIVE' && (await Room.exists({ roomTypeId: id, isActive: true, deletedAt: null }))) {
      throw ApiError.conflict('Deactivate or move the rooms of this type first', 'ROOM_TYPE_IN_USE');
    }
    if (patch.capacity && patch.capacity < before.capacity) { /* existing bookings keep their snapshots; new searches use the new capacity */ }
    const after = await RoomType.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await auditService.log(caller.user, ctx, 'ROOM_TYPE_UPDATED', 'RoomType', id, { before, after });
    return after.toJSON();
  },
};
