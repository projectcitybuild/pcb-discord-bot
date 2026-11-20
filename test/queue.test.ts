import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteQueue } from '../src/queue/sqlite-queue.js';

const syncId = 'c2cb173a-6976-4dcb-a9b4-d8932cc77e08';
const userId = '12345678901234567';
const directories: string[] = [];

function createQueue(maxSize = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'pcb-queue-'));
  directories.push(directory);
  return {
    queue: new SqliteQueue(join(directory, 'queue.sqlite'), maxSize),
    path: join(directory, 'queue.sqlite'),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('SqliteQueue', () => {
  it('accepts once, deduplicates sync IDs, and persists across reopen', () => {
    const { queue, path } = createQueue();
    expect(queue.enqueue(syncId, userId, 100)).toBe('accepted');
    expect(queue.enqueue(syncId, userId, 101)).toBe('duplicate');
    queue.close();
    const reopened = new SqliteQueue(path, 10);
    expect(reopened.get(syncId)?.status).toBe('pending');
    reopened.close();
  });

  it('recovers processing jobs and applies bounded retry limits', () => {
    const { queue, path } = createQueue();
    queue.enqueue(syncId, userId, 100);
    const claimed = queue.claimNext(new Set(), 100);
    expect(claimed?.attempts).toBe(1);
    queue.close();

    const recovered = new SqliteQueue(path, 10);
    expect(recovered.get(syncId)?.status).toBe('pending');
    const secondClaim = recovered.claimNext(new Set(), 101);
    expect(secondClaim?.attempts).toBe(2);
    expect(
      recovered.fail({
        syncId,
        attempts: 2,
        maxAttempts: 2,
        retryable: true,
        retryBaseMs: 10,
        retryMaxMs: 20,
        error: 'temporary',
        now: 102,
      }),
    ).toBe('failed');
    expect(recovered.get(syncId)?.lastError).toBe('temporary');
    recovered.close();
  });

  it('does not claim two jobs for a user already being processed and enforces growth limits', () => {
    const { queue } = createQueue(1);
    queue.enqueue(syncId, userId, 100);
    expect(
      queue.enqueue(
        '49c3b548-9748-457b-8dab-8177243db982',
        '12345678901234568',
        101,
      ),
    ).toBe('full');
    expect(queue.claimNext(new Set([userId]), 102)).toBeUndefined();
    queue.close();
  });
});
