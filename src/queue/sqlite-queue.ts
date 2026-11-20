import Database from 'better-sqlite3';

export type QueueJob = {
  syncId: string;
  discordUserId: string;
  attempts: number;
};

export type EnqueueResult = 'accepted' | 'duplicate' | 'full';

export type QueueStats = {
  pending: number;
  processing: number;
  failed: number;
};

type QueueRow = { sync_id: string; discord_user_id: string; attempts: number };

export class SqliteQueue {
  private readonly database: Database.Database;

  constructor(
    path: string,
    private readonly maxSize: number,
  ) {
    this.database = new Database(path);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_jobs (
        sync_id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_jobs_ready ON sync_jobs(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS sync_jobs_user ON sync_jobs(discord_user_id, status);
      UPDATE sync_jobs SET status = 'pending', updated_at = unixepoch('subsec') * 1000
        WHERE status = 'processing';
    `);
  }

  enqueue(
    syncId: string,
    discordUserId: string,
    now = Date.now(),
  ): EnqueueResult {
    const transaction = this.database.transaction((): EnqueueResult => {
      this.database
        .prepare(
          "DELETE FROM sync_jobs WHERE status IN ('completed', 'failed') AND updated_at < ?",
        )
        .run(now - 30 * 24 * 60 * 60 * 1000);
      if (this.hasSyncId(syncId)) return 'duplicate';
      const count = this.database
        .prepare('SELECT COUNT(*) AS count FROM sync_jobs')
        .get() as { count: number };
      if (count.count >= this.maxSize) return 'full';
      const insert = this.database.prepare(`
      INSERT OR IGNORE INTO sync_jobs
        (sync_id, discord_user_id, status, attempts, created_at, updated_at, available_at)
      VALUES (?, ?, 'pending', 0, ?, ?, ?)
    `);
      return insert.run(syncId, discordUserId, now, now, now).changes > 0
        ? 'accepted'
        : 'duplicate';
    });
    return transaction();
  }

  claimNext(
    excludedUsers: ReadonlySet<string>,
    now = Date.now(),
  ): QueueJob | undefined {
    const transaction = this.database.transaction((): QueueJob | undefined => {
      const rows = this.database
        .prepare(
          `
        SELECT sync_id, discord_user_id, attempts FROM sync_jobs
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY created_at ASC
      `,
        )
        .all(now) as QueueRow[];
      const row = rows.find(
        (candidate) => !excludedUsers.has(candidate.discord_user_id),
      );
      if (!row) return undefined;
      const changed = this.database
        .prepare(
          `
        UPDATE sync_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE sync_id = ? AND status = 'pending'
      `,
        )
        .run(now, row.sync_id).changes;
      return changed
        ? {
            syncId: row.sync_id,
            discordUserId: row.discord_user_id,
            attempts: row.attempts + 1,
          }
        : undefined;
    });
    return transaction();
  }

  complete(syncId: string, now = Date.now()): void {
    this.database
      .prepare(
        "UPDATE sync_jobs SET status = 'completed', updated_at = ?, last_error = NULL WHERE sync_id = ?",
      )
      .run(now, syncId);
  }

  fail(input: {
    syncId: string;
    attempts: number;
    maxAttempts: number;
    retryable: boolean;
    retryBaseMs: number;
    retryMaxMs: number;
    error: string;
    now?: number;
  }): 'pending' | 'failed' {
    const now = input.now ?? Date.now();
    const failed = !input.retryable || input.attempts >= input.maxAttempts;
    const delay = Math.min(
      input.retryBaseMs * 2 ** Math.max(0, input.attempts - 1),
      input.retryMaxMs,
    );
    this.database
      .prepare(
        `
      UPDATE sync_jobs SET status = ?, updated_at = ?, available_at = ?, last_error = ? WHERE sync_id = ?
    `,
      )
      .run(
        failed ? 'failed' : 'pending',
        now,
        failed ? now : now + delay,
        input.error.slice(0, 300),
        input.syncId,
      );
    return failed ? 'failed' : 'pending';
  }

  stats(): QueueStats {
    const rows = this.database
      .prepare(
        'SELECT status, COUNT(*) AS count FROM sync_jobs GROUP BY status',
      )
      .all() as Array<{ status: string; count: number }>;
    const result: QueueStats = { pending: 0, processing: 0, failed: 0 };
    for (const row of rows) {
      if (
        row.status === 'pending' ||
        row.status === 'processing' ||
        row.status === 'failed'
      )
        result[row.status] = row.count;
    }
    return result;
  }

  get(
    syncId: string,
  ): (QueueJob & { status: string; lastError: string | null }) | undefined {
    const row = this.database
      .prepare('SELECT * FROM sync_jobs WHERE sync_id = ?')
      .get(syncId) as
      (QueueRow & { status: string; last_error: string | null }) | undefined;
    return (
      row && {
        syncId: row.sync_id,
        discordUserId: row.discord_user_id,
        attempts: row.attempts,
        status: row.status,
        lastError: row.last_error,
      }
    );
  }

  close(): void {
    this.database.close();
  }

  private hasSyncId(syncId: string): boolean {
    return Boolean(
      this.database
        .prepare('SELECT 1 FROM sync_jobs WHERE sync_id = ?')
        .get(syncId),
    );
  }
}
