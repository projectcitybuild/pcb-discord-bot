import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { DiscordGateway } from '../src/discord/client.js';

const guildId = '12345678901234567';
const userId = '23456789012345678';
const roleIds = ['34567890123456789', '45678901234567890'];
const reason = 'PCB website role synchronization';

function setup(member: object = { roles: { add: vi.fn(), remove: vi.fn() } }) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const config = {
    DISCORD_GUILD_ID: guildId,
    DISCORD_BOT_TOKEN: 'test-token',
  } as AppConfig;
  const gateway = new DiscordGateway(config, logger);
  const membersFetch = vi.fn(async () => member);
  const rolesFetch = vi.fn(async () => new Map());
  const guild = {
    id: guildId,
    members: { fetch: membersFetch },
    roles: { fetch: rolesFetch },
  };
  vi.spyOn(gateway.client.guilds, 'fetch').mockResolvedValue(guild as never);
  return { gateway, guild, logger, membersFetch, rolesFetch, member };
}

describe('DiscordGateway', () => {
  it('passes role additions and removals to the fetched member', async () => {
    const member = {
      roles: { add: vi.fn(), remove: vi.fn() },
    };
    const { gateway, membersFetch } = setup(member);

    await gateway.addRoles(userId, roleIds);
    await gateway.removeRoles(userId, roleIds);

    expect(membersFetch).toHaveBeenCalledWith({ user: userId, force: true });
    expect(member.roles.add).toHaveBeenCalledWith(roleIds, reason);
    expect(member.roles.remove).toHaveBeenCalledWith(roleIds, reason);
  });

  it('returns current and valid guild role IDs from Discord', async () => {
    const member = {
      roles: { cache: new Map([['34567890123456789', {}]]) },
    };
    const { gateway, rolesFetch } = setup(member);
    rolesFetch.mockResolvedValue(
      new Map([
        ['34567890123456789', {}],
        ['45678901234567890', {}],
      ]),
    );

    const snapshot = await gateway.getMember(userId);

    expect(snapshot.roleIds).toEqual(new Set(['34567890123456789']));
    expect(snapshot.validGuildRoleIds).toEqual(new Set(roleIds));
  });

  it('sends a private role change notification to the Discord user', async () => {
    const send = vi.fn();
    const { gateway, rolesFetch } = setup();
    rolesFetch.mockResolvedValue(
      new Map([
        [roleIds[0]!, { name: 'Builder' }],
        [roleIds[1]!, { name: 'Event Host' }],
      ]) as never,
    );
    vi.spyOn(gateway.client.users, 'fetch').mockResolvedValue({
      send,
    } as never);

    await gateway.notifyRoleChange(userId, {
      added: [roleIds[0]!],
      removed: [roleIds[1]!],
    });

    expect(send).toHaveBeenCalledWith(
      '**Role Update**\n\nThe following changes have been made to your Discord roles:\n\n- **Builder** has been added.\n- **Event Host** has been removed.',
    );
  });

  it('logs and ignores private message delivery failures', async () => {
    const error = new Error('Cannot send messages to this user');
    const { gateway, logger } = setup();
    vi.spyOn(gateway.client.users, 'fetch').mockRejectedValue(error);

    await expect(
      gateway.notifyRoleChange(userId, { added: roleIds, removed: [] }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      { discordUserId: userId, err: error },
      'Could not send Discord role change notification',
    );
  });

  it.each([
    [
      'linked',
      '**Discord Account Linked**\n\nYour Discord account is now linked to your Project City account. Your server roles will be synchronized shortly.',
    ],
    [
      'disconnected',
      '**Discord Account Disconnected**\n\nYour Discord account has been disconnected from your Project City account.',
    ],
  ] as const)('sends an account %s notification', async (event, message) => {
    const send = vi.fn();
    const { gateway } = setup();
    vi.spyOn(gateway.client.users, 'fetch').mockResolvedValue({ send } as never);

    await gateway.notifyAccountEvent(userId, event);

    expect(send).toHaveBeenCalledWith(message);
  });

  it('propagates member lookup errors for reconciliation classification', async () => {
    const missingMember = Object.assign(new Error('Unknown Member'), {
      code: 10007,
      status: 404,
    });
    const { gateway, membersFetch } = setup();
    membersFetch.mockRejectedValue(missingMember);

    await expect(gateway.addRoles(userId, roleIds)).rejects.toBe(missingMember);
  });
});
