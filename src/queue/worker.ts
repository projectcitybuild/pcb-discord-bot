import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { sanitizedError, SyncFailure } from '../errors.js';
import type { SqliteQueue } from './sqlite-queue.js';
import type { RoleReconciler } from '../sync/reconciler.js';

export class QueueWorker {
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private wakePoll: (() => void) | undefined;
  private readonly activeUsers = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();

  constructor(
    private readonly queue: SqliteQueue,
    private readonly reconciler: RoleReconciler,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  get processing(): boolean {
    return this.activeTasks.size > 0;
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakePoll?.();
    await this.loopPromise;
    await Promise.all(this.activeTasks);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let claimed = false;
      while (
        !this.stopping &&
        this.activeTasks.size < this.config.QUEUE_CONCURRENCY
      ) {
        let job;
        try {
          job = this.queue.claimNext(this.activeUsers);
        } catch (error) {
          this.logger.error(
            { error: sanitizedError(error) },
            'Queue job claim failed',
          );
          break;
        }
        if (!job) break;
        claimed = true;
        this.activeUsers.add(job.discordUserId);
        const task = this.process(job)
          .catch((error: unknown) => {
            this.logger.error(
              {
                syncId: job.syncId,
                discordUserId: job.discordUserId,
                error: sanitizedError(error),
              },
              'Queue worker job failed unexpectedly',
            );
          })
          .finally(() => {
            this.activeUsers.delete(job.discordUserId);
            this.activeTasks.delete(task);
          });
        this.activeTasks.add(task);
      }
      if (!claimed) await this.waitForPoll();
    }
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakePoll = undefined;
        resolve();
      }, this.config.QUEUE_POLL_INTERVAL_MS);
      this.wakePoll = () => {
        clearTimeout(timer);
        this.wakePoll = undefined;
        resolve();
      };
    });
  }

  private async process(job: {
    syncId: string;
    discordUserId: string;
    attempts: number;
  }): Promise<void> {
    try {
      const result = await this.reconciler.reconcile(job.discordUserId);
      this.queue.complete(job.syncId);
      this.logger.info(
        {
          syncId: job.syncId,
          discordUserId: job.discordUserId,
          rolesAdded: result.added.length,
          rolesRemoved: result.removed.length,
        },
        'Discord role sync completed',
      );
    } catch (error) {
      const retryable = error instanceof SyncFailure ? error.retryable : true;
      const lastError = sanitizedError(error);
      const status = this.queue.fail({
        syncId: job.syncId,
        attempts: job.attempts,
        maxAttempts: this.config.QUEUE_MAX_ATTEMPTS,
        retryable,
        retryBaseMs: this.config.QUEUE_RETRY_BASE_MS,
        retryMaxMs: this.config.QUEUE_RETRY_MAX_MS,
        error: lastError,
      });
      if (status === 'failed') {
        this.logger.error(
          {
            syncId: job.syncId,
            discordUserId: job.discordUserId,
            attempts: job.attempts,
            error: lastError,
          },
          'Discord role sync permanently failed',
        );
      } else {
        this.logger.warn(
          {
            syncId: job.syncId,
            discordUserId: job.discordUserId,
            attempts: job.attempts,
            error: lastError,
          },
          'Discord role sync will retry',
        );
      }
    }
  }
}
