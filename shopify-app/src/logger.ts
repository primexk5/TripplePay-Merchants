import { pino, type Logger } from 'pino';

export function log(scope: string): Logger {
  const pretty = ['true', '1', 'yes', 'on'].includes(String(process.env.LOG_PRETTY ?? '').toLowerCase());
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
    base: { scope },
  });
}