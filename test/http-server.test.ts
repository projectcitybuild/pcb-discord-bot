import { createHmac } from 'node:crypto';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/http/server.js';
import type { SqliteQueue } from '../src/queue/sqlite-queue.js';
import type { QueueWorker } from '../src/queue/worker.js';

const config = loadConfig({
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_GUILD_ID: '12345678901234567',
  WEBHOOK_SECRET: 'webhook-secret',
  WEB_API_BASE_URL: 'https://api.example.test',
  WEB_API_CLIENT_ID: 'client-id',
  WEB_API_CLIENT_SECRET: 'client-secret',
});

const queue = {
  enqueue: vi.fn().mockReturnValue('accepted'),
  stats: vi.fn().mockReturnValue({ pending: 0, processing: 0, failed: 0 }),
} as unknown as SqliteQueue;
const worker = { processing: false } as unknown as QueueWorker;
const notifyAccountEvent = vi.fn(async () => undefined);
const app = createHttpServer({
  config,
  queue,
  worker,
  discordReady: () => true,
  notifyAccountEvent,
  logger: pino({ level: 'silent' }),
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('role-sync webhook endpoint', () => {
  it('authenticates exact Laravel request bytes and persists before returning 202', async () => {
    const body =
      '{"discord_user_id":"23456789012345678","sync_id":"c2cb173a-6976-4dcb-a9b4-d8932cc77e08"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', config.WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/discord/role-sync',
      headers: {
        'content-type': 'application/json',
        'x-discord-timestamp': timestamp,
        'x-discord-signature': `sha256=${signature}`,
        'idempotency-key': 'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(queue.enqueue).toHaveBeenCalledWith(
      'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
      '23456789012345678',
    );
  });

  it('rejects invalid signatures without queueing the request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/discord/role-sync',
      headers: {
        'content-type': 'application/json',
        'x-discord-timestamp': Math.floor(Date.now() / 1000).toString(),
        'x-discord-signature': `sha256=${'0'.repeat(64)}`,
        'idempotency-key': 'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
      },
      payload:
        '{"discord_user_id":"23456789012345678","sync_id":"c2cb173a-6976-4dcb-a9b4-d8932cc77e08"}',
    });
    expect(response.statusCode).toBe(401);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it.each(['linked', 'disconnected'] as const)(
    'notifies the Discord user when their account is %s',
    async (accountEvent) => {
      const body = JSON.stringify({
        discord_user_id: '23456789012345678',
        sync_id: 'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
        account_event: accountEvent,
      });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', config.WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/discord/role-sync',
        headers: {
          'content-type': 'application/json',
          'x-discord-timestamp': timestamp,
          'x-discord-signature': `sha256=${signature}`,
          'idempotency-key': 'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
        },
        payload: body,
      });

      expect(response.statusCode).toBe(202);
      expect(notifyAccountEvent).toHaveBeenCalledWith(
        '23456789012345678',
        accountEvent,
      );
    },
  );

  it('does not repeat an account notification for a duplicate callback', async () => {
    vi.mocked(queue.enqueue).mockReturnValueOnce('duplicate');
    const body =
      '{"discord_user_id":"23456789012345678","sync_id":"c2cb173a-6976-4dcb-a9b4-d8932cc77e08","account_event":"linked"}';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', config.WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/discord/role-sync',
      headers: {
        'content-type': 'application/json',
        'x-discord-timestamp': timestamp,
        'x-discord-signature': `sha256=${signature}`,
        'idempotency-key': 'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
      },
      payload: body,
    });

    expect(response.statusCode).toBe(202);
    expect(notifyAccountEvent).not.toHaveBeenCalled();
  });
});
