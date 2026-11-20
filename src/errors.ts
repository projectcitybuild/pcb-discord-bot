export class SyncFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SyncFailure';
  }
}

export function classifyDiscordError(error: unknown): SyncFailure {
  const candidate = error as {
    status?: number;
    code?: number | string;
    rawError?: { code?: number };
  };
  const status = candidate?.status;
  const code = candidate?.code ?? candidate?.rawError?.code;
  const retryable =
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    status === undefined;
  const reason =
    code === 10007
      ? 'Discord member is not in the configured guild'
      : code === 10011
        ? 'A configured Discord role no longer exists'
        : code === 50013
          ? 'Discord bot lacks permission or role hierarchy access'
          : code === 50001
            ? 'Discord bot lacks access to the configured guild or member'
            : status === 429
              ? 'Discord rate limit encountered'
              : 'Discord role reconciliation failed';
  return new SyncFailure(reason, retryable, { cause: error });
}

export function sanitizedError(error: unknown): string {
  if (error instanceof SyncFailure) return error.message.slice(0, 300);
  return 'Unexpected synchronization error';
}
