import pino, { type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

const MASKED_KEYS = ['token', 'authorization', 'apiKey', 'secret', 'password', 'email', 'to', 'clientSecret'];

export function createLogger(opts: { stream?: NodeJS.WritableStream; level?: string } = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      redact: {
        paths: [...MASKED_KEYS, ...MASKED_KEYS.map((k) => `*.${k}`)],
        censor: '[masqué]',
      },
      formatters: { level: (label) => ({ level: label }) },
    },
    opts.stream,
  );
}

export const silentLogger = (): Logger => createLogger({ level: 'silent' });
