/** Who/where a request came from; passed to services for audit logs and session device info. */
export const getRequestContext = (req) => ({
  ip: req.ip,
  userAgent: (req.get('user-agent') || 'unknown').slice(0, 300),
  requestId: req.id,
});
