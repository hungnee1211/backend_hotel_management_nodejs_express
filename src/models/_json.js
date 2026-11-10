/** Shared toJSON transform: expose `id` instead of `_id`, drop internals. */
export const jsonTransform = (_doc, ret) => {
  ret.id = String(ret._id);
  delete ret._id;
  delete ret.__v;
  return ret;
};
