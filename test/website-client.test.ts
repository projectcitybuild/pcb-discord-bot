import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { WebsiteClient } from '../src/api/website-client.js';

const environment = {
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_GUILD_ID: '12345678901234567',
  WEBHOOK_SECRET: 'webhook-secret',
  WEB_API_BASE_URL: 'https://api.example.test',
  WEB_API_CLIENT_ID: 'client-id',
  WEB_API_CLIENT_SECRET: 'client-secret',
  WEB_API_SCOPE: 'discord.roles.sync',
  WEB_API_MAX_RETRIES: '1',
};
const userId = '23456789012345678';
const roleState = {
  discord_user_id: userId,
  guild_id: environment.DISCORD_GUILD_ID,
  linked: true,
  managed_role_ids: ['34567890123456789'],
  desired_role_ids: ['34567890123456789'],
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WebsiteClient', () => {
  it('acquires and caches a Passport client-credentials token', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ access_token: 'access-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(response(roleState))
      .mockResolvedValueOnce(response(roleState));
    const client = new WebsiteClient(
      loadConfig(environment),
      fetcher,
      async () => undefined,
    );
    await client.getDesiredRoles(userId);
    await client.getDesiredRoles(userId);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe(
      'https://api.example.test/oauth/token',
    );
    expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(fetcher.mock.calls[0]?.[1].body).toContain(
      'grant_type=client_credentials',
    );
    expect(fetcher.mock.calls[1]?.[0].toString()).toBe(
      `https://api.example.test/v3/discord/users/${userId}/roles`,
    );
  });

  it('validates API schemas and retries transient failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ access_token: 'access-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(response({ error: 'busy' }, 503))
      .mockResolvedValueOnce(response(roleState));
    const client = new WebsiteClient(
      loadConfig(environment),
      fetcher,
      async () => undefined,
    );
    await expect(client.getDesiredRoles(userId)).resolves.toMatchObject(
      roleState,
    );

    const malformed = new WebsiteClient(
      loadConfig(environment),
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ access_token: 'access-token', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(response({ ...roleState, linked: 'yes' })),
      async () => undefined,
    );
    await expect(malformed.getDesiredRoles(userId)).rejects.toThrow(
      'invalid role-state schema',
    );
  });

  it('reacquires a token after an API authorization rejection', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ access_token: 'old-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(
        response({ access_token: 'new-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(response(roleState));
    const client = new WebsiteClient(
      loadConfig(environment),
      fetcher,
      async () => undefined,
    );
    await expect(client.getDesiredRoles(userId)).resolves.toMatchObject(
      roleState,
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
