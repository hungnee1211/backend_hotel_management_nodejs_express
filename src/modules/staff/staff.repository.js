import mongoose from 'mongoose';
import StaffProfile from '../../models/StaffProfile.js';
import User from '../../models/User.js';
import { escapeRegex } from '../../utils/pagination.js';

const USERS = User.collection.name;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

/** Joins profile + user and exposes ONLY safe fields (never the password hash or token version). */
const joinUser = (profileMatch, userMatch = {}) => [
  { $match: profileMatch },
  { $lookup: { from: USERS, localField: 'userId', foreignField: '_id', as: 'user' } },
  { $unwind: '$user' },
  { $match: { 'user.deletedAt': null, ...userMatch } },
];

const withManager = [
  { $lookup: { from: USERS, localField: 'managerId', foreignField: '_id', as: 'manager' } },
  { $unwind: { path: '$manager', preserveNullAndEmptyArrays: true } },
];

const VIEW = {
  _id: 0,
  id: '$user._id',
  fullName: '$user.fullName',
  email: '$user.email',
  phone: '$user.phone',
  avatar: '$user.avatar',
  role: '$user.role',
  status: '$user.status',
  isVerified: '$user.isVerified',
  lastLoginAt: '$user.lastLoginAt',
  createdAt: '$user.createdAt',
  employeeCode: 1,
  department: 1,
  jobTitle: 1,
  hiredAt: 1,
  managerId: 1,
  manager: { $cond: [{ $ifNull: ['$manager', false] }, { id: '$manager._id', fullName: '$manager.fullName' }, null] },
  permissionOverrides: 1,
};

const SORT_FIELDS = { createdAt: 'user.createdAt', fullName: 'user.fullName', department: 'department', employeeCode: 'employeeCode' };

export const staffRepository = {
  createProfile: async (data, { session } = {}) => (await StaffProfile.create([data], { session }))[0],
  findProfileByUserId: (userId) => StaffProfile.findOne({ userId }),
  updateProfile: (userId, update) => StaffProfile.findOneAndUpdate({ userId }, update, { new: true, runValidators: true }),

  listUserIdsByManager: (managerId) => StaffProfile.find({ managerId }).distinct('userId'),

  /** Active, non-deleted staff currently reporting to this manager. */
  countActiveReports: async (managerId) => {
    const [row] = await StaffProfile.aggregate([
      ...joinUser({ managerId: oid(managerId) }, { 'user.status': 'ACTIVE' }),
      { $count: 'n' },
    ]);
    return row?.n ?? 0;
  },

  reassignAll: async (fromManagerId, toManagerId) =>
    (await StaffProfile.updateMany({ managerId: fromManagerId }, { $set: { managerId: toManagerId } })).modifiedCount,

  findView: async (userId) => {
    const [row] = await StaffProfile.aggregate([...joinUser({ userId: oid(userId) }), ...withManager, { $project: VIEW }]);
    return row ?? null;
  },

  search: async ({ managerId, department, status, search }, { skip, limit, sortBy = 'createdAt', dir = -1 }) => {
    const profileMatch = {};
    if (managerId) profileMatch.managerId = oid(managerId);
    if (department) profileMatch.department = department;
    const userMatch = {};
    if (status) userMatch['user.status'] = status;
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      userMatch.$or = [{ 'user.fullName': rx }, { 'user.email': rx }, { 'user.phone': rx }, { employeeCode: rx }];
    }
    const sortKey = SORT_FIELDS[sortBy] ?? SORT_FIELDS.createdAt;
    const [result] = await StaffProfile.aggregate([
      ...joinUser(profileMatch, userMatch),
      { $sort: { [sortKey]: dir, _id: dir } },
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: limit }, ...withManager, { $project: VIEW }],
          total: [{ $count: 'n' }],
        },
      },
    ]);
    return { items: result.items, total: result.total[0]?.n ?? 0 };
  },
};
