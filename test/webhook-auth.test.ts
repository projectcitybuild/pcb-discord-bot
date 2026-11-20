import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { verifyWebhook } from '../src/webhook/auth.js';

const secret = 'test-secret';
const body = Buffer.from(
  '{"discord_user_id":"12345678901234567","sync_id":"c2cb173a-6976-4dcb-a9b4-d8932cc77e08"}',
);
const timestamp = '1700000000';
const signature = `sha256=${createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex')}`;

describe('verifyWebhook', () => {
  it('accepts Laravel exact-body HMAC signatures', () => {
    expect(
      verifyWebhook({
        body,
        timestamp,
        signature,
        secret,
        maxAgeSeconds: 300,
        nowSeconds: 1700000000,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects altered bodies and malformed signatures', () => {
    expect(
      verifyWebhook({
        body: Buffer.from(`${body.toString()} `),
        timestamp,
        signature,
        secret,
        maxAgeSeconds: 300,
        nowSeconds: 1700000000,
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhook({
        body,
        timestamp,
        signature: 'sha256=bad',
        secret,
        maxAgeSeconds: 300,
        nowSeconds: 1700000000,
      }).ok,
    ).toBe(false);
  });

  it('rejects stale timestamps', () => {
    expect(
      verifyWebhook({
        body,
        timestamp,
        signature,
        secret,
        maxAgeSeconds: 300,
        nowSeconds: 1700000400,
      }),
    ).toEqual({ ok: false, reason: 'expired_timestamp' });
  });

  it('uses timingSafeEqual for a well-formed signature', () => {
    const compare = vi.fn(timingSafeEqual);
    verifyWebhook({
      body,
      timestamp,
      signature,
      secret,
      maxAgeSeconds: 300,
      nowSeconds: 1700000000,
      compare,
    });
    expect(compare).toHaveBeenCalledOnce();
  });
});
