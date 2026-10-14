import pino, { type Logger } from 'pino';

// Dados pessoais e segredos nunca vão para o log. Conteúdo de mensagens também não.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-api-key"]',
  '*.access_token',
  '*.accessToken',
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.body',
  '*.text',
  '*.transcript',
  '*.wa_id',
  '*.waId',
  '*.phone',
  'body',
  'text',
  'transcript',
];

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    base: { service: 'ai-receptionist' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}

export type { Logger };
