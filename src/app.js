import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/environment.js';
import { requestLogger } from './middlewares/request-logger.js';
import { globalRateLimiter } from './middlewares/rate-limiter.js';
import { csrfProtection } from './middlewares/csrf.js';
import { rejectUnsafeInput } from './middlewares/sanitize.js';
import { notFound } from './middlewares/not-found.js';
import { errorHandler } from './middlewares/error-handler.js';
import { ApiError } from './utils/ApiError.js';
import routes from './routes/index.js';
import { mountDocs } from './docs/index.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY);

app.use(requestLogger);
app.use(helmet());
app.use(
  cors({
    credentials: true, // required for HTTP-only cookie auth from the frontend
    origin: (origin, callback) => {
      // No Origin header = non-browser client (curl, server-to-server, webhooks).
      if (!origin || env.clientOrigins.includes(origin)) return callback(null, true);
      return callback(ApiError.forbidden('Origin not allowed by CORS', 'CORS_FORBIDDEN'));
    },
  }),
);
app.use(globalRateLimiter);
// rawBody is kept so payment webhooks can verify their HMAC signature over the exact bytes received
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use(csrfProtection);
app.use(rejectUnsafeInput);

app.use('/api', routes);
if (env.docsEnabled) mountDocs(app);

app.use(notFound);
app.use(errorHandler);

export default app;
