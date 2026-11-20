import { z } from 'zod';
import { Agent } from 'undici';
import type { AppConfig } from '../config.js';
import { SyncFailure } from '../errors.js';

const roleStateSchema = z
  .object({
    discord_user_id: z.string().regex(/^\d{17,20}$/),
    guild_id: z.string().regex(/^\d{17,20}$/),
    linked: z.boolean(),
    managed_role_ids: z.array(z.string().regex(/^\d{17,20}$/)),
    desired_role_ids: z.array(z.string().regex(/^\d{17,20}$/)),
  })
  .strict();

export type RoleState = z.infer<typeof roleStateSchema>;

type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

type Token = { value: string; expiresAt: number };

export class WebsiteClient {
  private token: Token | undefined;
  private readonly dispatcher: Agent;

  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: Fetch = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.dispatcher = new Agent({
      connect: { timeout: config.WEB_API_CONNECT_TIMEOUT_MS },
    });
  }

  async getDesiredRoles(discordUserId: string): Promise<RoleState> {
    const endpoint = new URL(
      `/v3/discord/users/${encodeURIComponent(discordUserId)}/roles`,
      this.baseUrl(),
    );
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.getToken();
      response = await this.requestWithRetries(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401 || response.status === 403) {
        this.token = undefined;
        if (attempt === 0) continue;
        throw new SyncFailure(
          'Website API rejected the machine-client token or scope',
          false,
        );
      }
      break;
    }

    if (!response?.ok) {
      if (response && isTransient(response.status))
        throw new SyncFailure('Website API temporarily unavailable', true);
      throw new SyncFailure(
        `Website API rejected role lookup (${response?.status ?? 'no response'})`,
        false,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SyncFailure('Website API returned malformed JSON', false, {
        cause: error,
      });
    }
    const parsed = roleStateSchema.safeParse(payload);
    if (!parsed.success)
      throw new SyncFailure(
        'Website API returned an invalid role-state schema',
        false,
      );
    if (parsed.data.discord_user_id !== discordUserId) {
      throw new SyncFailure(
        'Website API returned role state for a different Discord user',
        false,
      );
    }
    if (
      parsed.data.desired_role_ids.some(
        (id) => !parsed.data.managed_role_ids.includes(id),
      )
    ) {
      throw new SyncFailure(
        'Website API returned a desired role outside the managed role set',
        false,
      );
    }
    return parsed.data;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000)
      return this.token.value;
    const endpoint = new URL('/oauth/token', this.baseUrl());
    const response = await this.requestWithRetries(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.WEB_API_CLIENT_ID,
        client_secret: this.config.WEB_API_CLIENT_SECRET,
        scope: this.config.WEB_API_SCOPE,
      }).toString(),
    });
    if (!response?.ok) {
      if (response && isTransient(response.status))
        throw new SyncFailure(
          'Website OAuth endpoint temporarily unavailable',
          true,
        );
      throw new SyncFailure(
        'Website OAuth client credentials were rejected',
        false,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SyncFailure(
        'Website OAuth endpoint returned malformed JSON',
        false,
        { cause: error },
      );
    }
    const parsed = z
      .object({
        access_token: z.string().min(1),
        expires_in: z.number().positive(),
      })
      .safeParse(payload);
    if (!parsed.success)
      throw new SyncFailure(
        'Website OAuth endpoint returned an invalid token response',
        false,
      );
    this.token = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
    };
    return this.token.value;
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.WEB_API_REQUEST_TIMEOUT_MS,
    );
    try {
      return await this.fetcher(url, {
        ...init,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      } as RequestInit);
    } catch (error) {
      throw new SyncFailure('Website API connection failed', true, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestWithRetries(
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    for (
      let attempt = 0;
      attempt <= this.config.WEB_API_MAX_RETRIES;
      attempt += 1
    ) {
      try {
        const response = await this.request(url, init);
        if (!isTransient(response.status)) return response;
        if (attempt === this.config.WEB_API_MAX_RETRIES) {
          throw new SyncFailure(
            'Website API temporarily unavailable after retries',
            true,
          );
        }
      } catch (error) {
        if (
          !(error instanceof SyncFailure) ||
          !error.retryable ||
          attempt === this.config.WEB_API_MAX_RETRIES
        )
          throw error;
      }
      await this.wait(backoff(attempt));
    }
    throw new SyncFailure(
      'Website API temporarily unavailable after retries',
      true,
    );
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private baseUrl(): URL {
    const base = new URL(this.config.WEB_API_BASE_URL);
    base.pathname = `${base.pathname.replace(/\/$/, '')}/`;
    return base;
  }
}

function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoff(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2000);
}
