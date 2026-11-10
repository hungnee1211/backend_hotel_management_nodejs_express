import mongoose from 'mongoose';
import Notification from '../../models/Notification.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPageMeta, parsePagination } from '../../utils/pagination.js';

export const inAppNotifications = {
  /** Creates one notification per user; a repeated `dedupeKey` for the same user is silently skipped. */
  async notify(userIds, { type, title, body, refType, refId, dedupeKey }) {
    let created = 0;
    for (const userId of [...new Set(userIds.map(String))]) {
      try { await Notification.create({ userId, type, title, body, refType, refId, dedupeKey }); created += 1; }
      catch (err) { if (err.code !== 11000) throw err; }
    }
    return created;
  },
  async list(user, q) {
    const filter = { userId: user._id, ...(q.unread ? { readAt: null } : {}) };
    const paging = parsePagination(q, { allowedSort: ['createdAt'], defaultSort: 'createdAt' });
    const [items, total, unread] = await Promise.all([Notification.find(filter).sort(paging.sort).skip(paging.skip).limit(paging.limit), Notification.countDocuments(filter), Notification.countDocuments({ userId: user._id, readAt: null })]);
    return { items: items.map((n) => n.toJSON()), meta: { ...buildPageMeta({ ...paging, total }), unread } };
  },
  async markRead(user, id) {
    const n = mongoose.isValidObjectId(id) ? await Notification.findOneAndUpdate({ _id: id, userId: user._id }, { $set: { readAt: new Date() } }, { new: true }) : null;
    if (!n) throw ApiError.notFound('Notification not found', 'NOTIFICATION_NOT_FOUND');
    return n.toJSON();
  },
  async markAllRead(user) { return { updated: (await Notification.updateMany({ userId: user._id, readAt: null }, { $set: { readAt: new Date() } })).modifiedCount }; },
};
