import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookAuthResult = { ok: true } | { ok: false; reason: string };

export function verifyWebhook(input: {
  body: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  maxAgeSeconds: number;
  nowSeconds?: number;
  compare?: typeof timingSafeEqual;
}): WebhookAuthResult {
  const { body, timestamp, signature, secret, maxAgeSeconds } = input;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp))
    return { ok: false, reason: 'invalid_timestamp' };
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return { ok: false, reason: 'invalid_signature' };

  const timestampSeconds = Number(timestamp);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds
  ) {
    return { ok: false, reason: 'expired_timestamp' };
  }

  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest();
  const supplied = Buffer.from(signature.slice('sha256='.length), 'hex');
  if (
    supplied.length !== expected.length ||
    !(input.compare ?? timingSafeEqual)(expected, supplied)
  ) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}
