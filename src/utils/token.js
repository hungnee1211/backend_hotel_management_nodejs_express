import jwt from 'jsonwebtoken';
import { env } from '../config/environment.js';

const ISSUER = 'hotel-management-api';
const ALGORITHM = 'HS256';

/** `ver` must match User.tokenVersion, so bumping the version revokes every outstanding access token. */
export const signAccessToken = (user) =>
  jwt.sign({ role: user.role, ver: user.tokenVersion ?? 0 }, env.JWT_ACCESS_SECRET, {
    subject: String(user._id),
    issuer: ISSUER,
    algorithm: ALGORITHM,
    expiresIn: Math.floor(env.accessTokenTtlMs / 1000),
  });

export const verifyAccessToken = (token) =>
  jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER, algorithms: [ALGORITHM] });
