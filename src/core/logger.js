import pino from 'pino';

const debug = process.argv.includes('--debug') || process.env.NEXUS_DEBUG === '1' || process.env.DEBUG === 'nexus';

export const logger = pino({
  level: debug ? 'debug' : (process.env.LOG_LEVEL || 'info')
});

export function createLogger(name) {
  return logger.child({ module: name });
}

export default logger;