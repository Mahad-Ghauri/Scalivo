import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging, from line one.
 *
 * This is not just debugging. The evaluation chapter's metrics — session uptime,
 * booking completion rate, retention conversion, review capture — can only be
 * computed from events captured as they happen. None of it is reconstructable
 * later, so every inbound/outbound message, FSM transition, booking lifecycle
 * event, and session status change gets logged from the first commit.
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  // Driver errors can embed duplicate keys or request payloads in their message.
  serializers: {
    err: (err: unknown) => {
      if (!(err instanceof Error)) return { type: 'Error' };
      return {
        type: err.name,
        stack: err.stack?.split('\n').slice(1).join('\n'),
        ...('code' in err && typeof err.code === 'number' ? { code: err.code } : {}),
      };
    },
  },
  redact: {
    // Message bodies are real people's conversations. Keep them out of general
    // logs; the message collection is the deliberate, access-controlled record.
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]', '*.body',
      'body',
      'qrCode',
      '*.qrCode',
      'contactPhone',
      'contactLid',
      'displayName',
      'email',
      '*.email',
      'phone',
      '*.phone',
      'apiKeyRef',
      '*.apiKeyRef',
      'to',
      'attemptedEmail',
      'fcmToken',
      '*.fcmToken',
      'req.body',
    ],
    censor: '[redacted]',
  },
});
