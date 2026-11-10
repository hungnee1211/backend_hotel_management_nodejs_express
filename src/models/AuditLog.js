import mongoose from 'mongoose';

const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    action: { type: String, required: true, index: true },
    resourceType: { type: String, required: true },
    resourceId: { type: Schema.Types.ObjectId, default: null },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ipAddress: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

auditLogSchema.index({ resourceType: 1, resourceId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

// Append-only at the application layer. For real tamper resistance, ALSO connect production with a
// database user that has only insert/find rights on this collection.
const IMMUTABLE_QUERY_OPS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace',
  'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete',
];
const refuse = () => { throw new Error('AuditLog is append-only'); };
auditLogSchema.pre(IMMUTABLE_QUERY_OPS, { query: true, document: false }, refuse);
auditLogSchema.pre('deleteOne', { document: true, query: false }, refuse);
auditLogSchema.pre('save', function blockResave() {
  if (!this.isNew) refuse();
});

export default mongoose.model('AuditLog', auditLogSchema);
