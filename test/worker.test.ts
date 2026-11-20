import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { SyncFailure } from '../src/errors.js';
import type { RoleReconciler } from '../src/sync/reconciler.js';
import type { QueueJob, SqliteQueue } from '../src/queue/sqlite-queue.js';
import { QueueWorker } from '../src/queue/worker.js';

const pollIntervalMs = 10;
const syncIds = [
  'c2cb173a-6976-4dcb-a9b4-d8932cc77e08',
  '49c3b548-9748-457b-8dab-8177243db982',
  '59c3b548-9748-457b-8dab-8177243db982',
];
const userIds = ['12345678901234567', '12345678901234568', '12345678901234569'];

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createQueue(jobs: QueueJob[]) {
  const waitingJobs = [...jobs];
  const queue = {
    claimNext: vi.fn((excludedUsers: ReadonlySet<string>) => {
      const index = waitingJobs.findIndex(
        (job) => !excludedUsers.has(job.discordUserId),
      );
      return index < 0 ? undefined : waitingJobs.splice(index, 1)[0];
    }),
    complete: vi.fn(),
    fail: vi.fn((): 'pending' | 'failed' => 'pending'),
  };
  return { queue, typedQueue: queue as unknown as SqliteQueue, waitingJobs };
}

function createWorker(
  queue: SqliteQueue,
  reconciler: Pick<RoleReconciler, 'reconcile'>,
  options: { concurrency?: number; maxAttempts?: number } = {},
) {
  const config = {
    QUEUE_CONCURRENCY: options.concurrency ?? 1,
    QUEUE_MAX_ATTEMPTS: options.maxAttempts ?? 3,
    QUEUE_RETRY_BASE_MS: 25,
    QUEUE_RETRY_MAX_MS: 90,
    QUEUE_POLL_INTERVAL_MS: pollIntervalMs,
  } as AppConfig;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return {
    worker: new QueueWorker(
      queue,
      reconciler as RoleReconciler,
      config,
      logger,
    ),
    logger,
  };
}

async function stopWorker(worker: QueueWorker) {
  const stopped = worker.stop();
  await vi.advanceTimersByTimeAsync(pollIntervalMs);
  await stopped;
}

function job(index: number, discordUserId = userIds[index]!) {
  return { syncId: syncIds[index]!, discordUserId, attempts: 1 };
}

const emptyResult = { added: [], removed: [] };

describe('QueueWorker', () => {
  it('marks a successfully reconciled job completed', async () => {
    vi.useFakeTimers();
    const { queue, typedQueue } = createQueue([job(0)]);
    const reconciler = { reconcile: vi.fn(async () => emptyResult) };
    const { worker } = createWorker(typedQueue, reconciler);
    const completed = deferred<void>();
    queue.complete.mockImplementation(() => completed.resolve());

    worker.start();
    await completed.promise;
    await stopWorker(worker);

    expect(queue.complete).toHaveBeenCalledWith(syncIds[0]);
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it('returns retryable failures to pending with configured attempts and backoff', async () => {
    vi.useFakeTimers();
    const { queue, typedQueue } = createQueue([job(0)]);
    const reconciler = {
      reconcile: vi.fn(async () => {
        throw new Error('temporary outage');
      }),
    };
    const { worker } = createWorker(typedQueue, reconciler, { maxAttempts: 4 });
    const failed = deferred<void>();
    queue.fail.mockImplementation(() => {
      failed.resolve();
      return 'pending';
    });

    worker.start();
    await failed.promise;
    await stopWorker(worker);

    expect(queue.fail).toHaveBeenCalledWith({
      syncId: syncIds[0],
      attempts: 1,
      maxAttempts: 4,
      retryable: true,
      retryBaseMs: 25,
      retryMaxMs: 90,
      error: 'Unexpected synchronization error',
    });
  });

  it('does not retry permanent SyncFailure and marks exhausted attempts failed', async () => {
    vi.useFakeTimers();
    const permanentQueue = createQueue([job(0)]);
    const permanentReconciler = {
      reconcile: vi.fn(async () => {
        throw new SyncFailure('invalid role state', false);
      }),
    };
    const permanentWorker = createWorker(
      permanentQueue.typedQueue,
      permanentReconciler,
    );
    const permanentFailure = deferred<void>();
    permanentQueue.queue.fail.mockImplementation(() => {
      permanentFailure.resolve();
      return 'failed';
    });
    permanentWorker.worker.start();
    await permanentFailure.promise;
    await stopWorker(permanentWorker.worker);
    expect(permanentQueue.queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ retryable: false, maxAttempts: 3 }),
    );

    vi.useFakeTimers();
    const exhaustedQueue = createQueue([{ ...job(1), attempts: 3 }]);
    const exhaustedReconciler = {
      reconcile: vi.fn(async () => {
        throw new SyncFailure('still unavailable', true);
      }),
    };
    const exhaustedWorker = createWorker(
      exhaustedQueue.typedQueue,
      exhaustedReconciler,
      { maxAttempts: 3 },
    );
    const exhaustedFailure = deferred<void>();
    exhaustedQueue.queue.fail.mockImplementation(() => {
      exhaustedFailure.resolve();
      return 'failed';
    });
    exhaustedWorker.worker.start();
    await exhaustedFailure.promise;
    await stopWorker(exhaustedWorker.worker);
    expect(exhaustedQueue.queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3, maxAttempts: 3, retryable: true }),
    );
  });

  it('continues after an unexpected job failure and releases that user for the next job', async () => {
    vi.useFakeTimers();
    const sameUserId = userIds[0]!;
    const { queue, typedQueue } = createQueue([
      job(0, sameUserId),
      job(1, sameUserId),
    ]);
    const completed = deferred<void>();
    const reconciler = {
      reconcile: vi
        .fn()
        .mockRejectedValueOnce(new Error('unexpected'))
        .mockResolvedValueOnce(emptyResult),
    };
    const { worker, logger } = createWorker(typedQueue, reconciler, {
      concurrency: 1,
    });
    queue.complete.mockImplementation(() => completed.resolve());
    const failed = deferred<void>();
    queue.fail.mockImplementation(() => {
      failed.resolve();
      return 'pending';
    });

    worker.start();
    await failed.promise;
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    await completed.promise;
    await stopWorker(worker);

    expect(reconciler.reconcile).toHaveBeenCalledTimes(2);
    expect(queue.complete).toHaveBeenCalledWith(syncIds[1]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('respects concurrency and processes a different user while one user is active', async () => {
    vi.useFakeTimers();
    const activeUserId = userIds[0]!;
    const otherUserId = userIds[1]!;
    const thirdUserId = userIds[2]!;
    const { typedQueue } = createQueue([
      job(0, activeUserId),
      job(1, activeUserId),
      job(2, otherUserId),
    ]);
    const releaseByUser = new Map<
      string,
      ReturnType<typeof deferred<typeof emptyResult>>
    >();
    const startedUsers: string[] = [];
    const startedTwice = deferred<void>();
    const startedThird = deferred<void>();
    const reconciler = {
      reconcile: vi.fn((discordUserId: string) => {
        startedUsers.push(discordUserId);
        if (startedUsers.length === 2) startedTwice.resolve();
        if (startedUsers.length === 3) startedThird.resolve();
        const result = deferred<typeof emptyResult>();
        releaseByUser.set(discordUserId, result);
        return result.promise;
      }),
    };
    const { worker } = createWorker(typedQueue, reconciler, { concurrency: 2 });

    worker.start();
    await startedTwice.promise;
    expect(startedUsers).toEqual([activeUserId, otherUserId]);
    expect(startedUsers).not.toContain(thirdUserId);

    releaseByUser.get(activeUserId)!.resolve(emptyResult);
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    await startedThird.promise;
    expect(
      startedUsers.filter((startedUser) => startedUser === activeUserId),
    ).toHaveLength(2);

    releaseByUser.get(activeUserId)!.resolve(emptyResult);
    releaseByUser.get(otherUserId)!.resolve(emptyResult);
    await stopWorker(worker);
  });

  it('stopping prevents further claims and waits for running jobs to finish', async () => {
    vi.useFakeTimers();
    const { queue, typedQueue, waitingJobs } = createQueue([job(0)]);
    const running = deferred<typeof emptyResult>();
    const started = deferred<void>();
    const reconciler = {
      reconcile: vi.fn(() => {
        started.resolve();
        return running.promise;
      }),
    };
    const { worker } = createWorker(typedQueue, reconciler);
    const completed = deferred<void>();
    queue.complete.mockImplementation(() => completed.resolve());

    worker.start();
    await started.promise;
    const stopping = worker.stop();
    waitingJobs.push(job(1));
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);

    running.resolve(emptyResult);
    await completed.promise;
    await stopping;
    expect(queue.complete).toHaveBeenCalledWith(syncIds[0]);
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
    expect(worker.processing).toBe(false);
  });
});
