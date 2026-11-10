import mongoose from 'mongoose';
import { ALL_PERMISSIONS } from '../constants/permissions.js';
import { DEPARTMENTS } from '../constants/index.js';

const { Schema } = mongoose;

/** Employment data for a User with role STAFF. 1:1 with the user. */
const staffProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    employeeCode: { type: String, required: true }, // EMP-00001, generated from a counter
    department: { type: String, enum: Object.values(DEPARTMENTS), required: true },
    jobTitle: { type: String, trim: true, maxlength: 120 },
    // The manager this person reports to. null = unassigned (only Admins can see/manage them).
    managerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    hiredAt: { type: Date },
    // Individual adjustments on top of the department's permissions (see effectivePermissions()).
    permissionOverrides: {
      grant: { type: [{ type: String, enum: ALL_PERMISSIONS }], default: [] },
      revoke: { type: [{ type: String, enum: ALL_PERMISSIONS }], default: [] },
    },
  },
  { timestamps: true },
);

staffProfileSchema.index({ userId: 1 }, { unique: true });
staffProfileSchema.index({ employeeCode: 1 }, { unique: true });
staffProfileSchema.index({ managerId: 1, department: 1 });
staffProfileSchema.index({ department: 1 });

export default mongoose.model('StaffProfile', staffProfileSchema);
