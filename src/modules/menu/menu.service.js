import mongoose from 'mongoose';
import MenuCategory from '../../models/MenuCategory.js';
import MenuItem from '../../models/MenuItem.js';
import { PERMISSIONS as P } from '../../constants/permissions.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/pagination.js';
import { auditService } from '../audit-logs/audit.service.js';

const manage = (caller) => caller.permissions.has(P.MENU_MANAGE);
const audit = (caller, ctx, action, type, id, before, after) => auditService.log(caller.user, ctx, action, type, id, { before, after });

export const menuService = {
  /** The browsable menu: active categories with their active items. Managers can also see hidden ones. */
  async menu(caller, q) {
    const all = manage(caller) && q.includeInactive;
    const catFilter = all ? {} : { status: 'ACTIVE' };
    if (q.categoryId) catFilter._id = q.categoryId;
    const categories = await MenuCategory.find(catFilter).sort({ name: 1 }).lean();
    const itemFilter = { categoryId: { $in: categories.map((c) => c._id) }, ...(all ? {} : { status: 'ACTIVE' }) };
    if (q.search) itemFilter.name = new RegExp(escapeRegex(q.search), 'i');
    if (q.minPrice !== undefined || q.maxPrice !== undefined) itemFilter.priceMinor = { ...(q.minPrice !== undefined && { $gte: q.minPrice }), ...(q.maxPrice !== undefined && { $lte: q.maxPrice }) };
    if (q.available) itemFilter.availability = true;
    const items = await MenuItem.find(itemFilter).sort({ name: 1 });
    return categories.map((c) => ({ id: String(c._id), name: c.name, description: c.description, image: c.image, status: c.status, items: items.filter((i) => String(i.categoryId) === String(c._id)).map((i) => i.toJSON()) })).filter((c) => !(q.search || q.minPrice !== undefined || q.maxPrice !== undefined || q.available) || c.items.length);
  },

  async createCategory(caller, data, ctx) { const c = await MenuCategory.create(data); await audit(caller, ctx, 'MENU_CATEGORY_CREATED', 'MenuCategory', c._id, null, c); return c.toJSON(); },
  async updateCategory(caller, id, patch, ctx) {
    const before = await MenuCategory.findById(id);
    if (!before) throw ApiError.notFound('Category not found', 'CATEGORY_NOT_FOUND');
    const after = await MenuCategory.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await audit(caller, ctx, 'MENU_CATEGORY_UPDATED', 'MenuCategory', id, before, after);
    return after.toJSON();
  },

  async createItem(caller, data, ctx) {
    const cat = await MenuCategory.findById(data.categoryId);
    if (!cat || cat.status !== 'ACTIVE') throw ApiError.unprocessable('categoryId must reference an active category', [{ field: 'body.categoryId', message: 'invalid' }]);
    const i = await MenuItem.create(data);
    await audit(caller, ctx, 'MENU_ITEM_CREATED', 'MenuItem', i._id, null, i);
    return i.toJSON();
  },
  async getItem(caller, id) {
    const i = mongoose.isValidObjectId(id) ? await MenuItem.findById(id) : null;
    if (!i || (!manage(caller) && i.status !== 'ACTIVE')) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
    return i.toJSON();
  },
  /** Price changes never touch existing orders: they carry their own price snapshot. */
  async updateItem(caller, id, patch, ctx) {
    const before = await MenuItem.findById(id);
    if (!before) throw ApiError.notFound('Menu item not found', 'MENU_ITEM_NOT_FOUND');
    if (patch.categoryId && !(await MenuCategory.exists({ _id: patch.categoryId }))) throw ApiError.unprocessable('Unknown category', [{ field: 'body.categoryId', message: 'invalid' }]);
    const after = await MenuItem.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true });
    await audit(caller, ctx, 'MENU_ITEM_UPDATED', 'MenuItem', id, before, after);
    return after.toJSON();
  },
};
