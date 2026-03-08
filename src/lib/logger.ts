import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

export default logger;

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
