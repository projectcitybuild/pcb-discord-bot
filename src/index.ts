import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pino from 'pino';
import { DiscordGateway } from './discord/client.js';
import { loadConfig } from './config.js';
import { createHttpServer } from './http/server.js';
import { SqliteQueue } from './queue/sqlite-queue.js';
import { QueueWorker } from './queue/worker.js';
import { RoleReconciler } from './sync/reconciler.js';
import { WebsiteClient } from './api/website-client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  
  await mkdir(dirname(config.SQLITE_PATH), { recursive: true });

  const queue = new SqliteQueue(config.SQLITE_PATH, config.QUEUE_MAX_SIZE);
  const discord = new DiscordGateway(config, logger);
  const website = new WebsiteClient(config);
  const reconciler = new RoleReconciler(
    config.DISCORD_GUILD_ID,
    discord,
    (discordUserId) => website.getDesiredRoles(discordUserId),
  );
  const worker = new QueueWorker(queue, reconciler, config, logger);
  const http = createHttpServer({
    config,
    queue,
    worker,
    discordReady: () => discord.isReady(),
    logger,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;

    logger.info({ signal }, 'Shutting down Project City Discord bot');

    if (http.server.listening) await http.close();

    await worker.stop();
    await discord.stop();
    await website.close();
    queue.close();

    logger.info('Goodbye');
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await discord.start();
    await http.listen({ host: config.HOST, port: config.PORT });
    worker.start();

    logger.info(
      { host: config.HOST, port: config.PORT, queue: queue.stats() },
      'Project City Build Discord bot started',
    );
  } catch (error) {
    logger.error({ err: error }, 'Project City Discord bot startup failed');
    await shutdown('startup-error');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
