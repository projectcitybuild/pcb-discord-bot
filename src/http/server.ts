import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { verifyWebhook } from '../webhook/auth.js';
import { syncWebhookSchema } from '../webhook/schema.js';
import type { SqliteQueue } from '../queue/sqlite-queue.js';
import type { QueueWorker } from '../queue/worker.js';

export function createHttpServer(input: {
  config: AppConfig;
  queue: SqliteQueue;
  worker: QueueWorker;
  discordReady: () => boolean;
  logger: Logger;
}) {
  const app = Fastify({ loggerInstance: input.logger });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.get('/health', async (_request, reply) => {
    const queue = input.queue.stats();
    const discordReady = input.discordReady();
    return reply.code(discordReady ? 200 : 503).send({
      http: 'ok',
      discord: discordReady ? 'ready' : 'disconnected',
      queue: { processing: input.worker.processing, pending: queue.pending },
    });
  });

  app.post('/webhooks/discord/role-sync', async (request, reply) => {
    if (!Buffer.isBuffer(request.body))
      return reply.code(400).send({ error: 'invalid_request' });
    const auth = verifyWebhook({
      body: request.body,
      timestamp: singleHeader(request.headers['x-discord-timestamp']),
      signature: singleHeader(request.headers['x-discord-signature']),
      secret: input.config.WEBHOOK_SECRET,
      maxAgeSeconds: input.config.WEBHOOK_MAX_AGE_SECONDS,
    });
    if (!auth.ok) {
      input.logger.warn(
        { reason: auth.reason },
        'Rejected unauthenticated Discord role sync webhook',
      );
      return reply.code(401).send({ error: 'unauthorized' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(request.body.toString('utf8')) as unknown;
    } catch {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const parsed = syncWebhookSchema.safeParse(payload);
    const idempotencyKey = singleHeader(request.headers['idempotency-key']);
    if (
      !parsed.success ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey !== parsed.data.sync_id
    ) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const result = input.queue.enqueue(
      parsed.data.sync_id,
      parsed.data.discord_user_id,
    );
    if (result === 'full')
      return reply.code(503).send({ error: 'queue_unavailable' });
    if (result === 'duplicate') {
      input.logger.info(
        { syncId: parsed.data.sync_id },
        'Duplicate Discord role sync webhook',
      );
      return reply.code(202).send({ accepted: true, duplicate: true });
    }
    input.logger.info(
      {
        syncId: parsed.data.sync_id,
        discordUserId: parsed.data.discord_user_id,
      },
      'Discord role sync accepted',
    );
    return reply.code(202).send({ accepted: true });
  });

  return app;
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
