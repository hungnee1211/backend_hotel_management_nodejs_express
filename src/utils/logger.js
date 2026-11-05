import winston from 'winston';
import { env } from '../config/environment.js';

const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${stack || message}${extra}`;
  }),
);

const prodFormat = winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json());

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  silent: env.isTest,
  format: env.isProd ? prodFormat : devFormat,
  transports: [new winston.transports.Console()],
});
