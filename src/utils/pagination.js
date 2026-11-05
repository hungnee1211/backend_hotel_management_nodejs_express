/** Parses ?page&limit&sortBy&order into skip/limit/sort. Callers pass an allow-list for sortBy. */
export const parsePagination = (query = {}, { maxLimit = 100, defaultLimit = 20, defaultSort = 'createdAt', allowedSort } = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), maxLimit);
  const requested = query.sortBy;
  const sortBy = requested && (!allowedSort || allowedSort.includes(requested)) ? requested : defaultSort;
  const dir = query.order === 'asc' ? 1 : -1;
  // _id as tiebreaker keeps pagination stable when many rows share a sort value.
  return { page, limit, skip: (page - 1) * limit, sort: { [sortBy]: dir, _id: dir } };
};

export const buildPageMeta = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
