import swaggerUi from 'swagger-ui-express';
import { buildOpenApi } from './openapi.js';

/** Serves Swagger UI at /api/docs and the raw spec at /api/docs/openapi.json (built once, on first request). */
export const mountDocs = (app) => {
  let spec;
  const get = () => (spec ??= buildOpenApi(app));
  app.get('/api/docs/openapi.json', (_req, res) => res.json(get()));
  app.use('/api/docs', swaggerUi.serve, (req, res, next) => swaggerUi.setup(get(), { customSiteTitle: 'Hotel API' })(req, res, next));
};
