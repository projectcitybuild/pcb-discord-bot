import { z } from 'zod';

const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, 'must be a 17-20 digit Discord snowflake');

const environmentSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: snowflake,
  WEBHOOK_SECRET: z.string().min(1),
  WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  WEB_API_BASE_URL: z.string().url(),
  WEB_API_CLIENT_ID: z.string().min(1),
  WEB_API_CLIENT_SECRET: z.string().min(1),
  WEB_API_SCOPE: z.string().min(1).default('discord.roles.sync'),
  WEB_API_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  WEB_API_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEB_API_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  SQLITE_PATH: z
    .string()
    .min(1)
    .default('./data/pcb-discord-bot.sqlite'),
  QUEUE_MAX_SIZE: z.coerce.number().int().positive().default(10000),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  QUEUE_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),
  QUEUE_RETRY_MAX_MS: z.coerce.number().int().positive().default(60000),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration: ${errors.join('; ')}`);
  }

  const baseUrl = new URL(parsed.data.WEB_API_BASE_URL);
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error(
      'Invalid environment configuration: WEB_API_BASE_URL must not contain credentials, query, or fragment',
    );
  }

  return parsed.data;
}
