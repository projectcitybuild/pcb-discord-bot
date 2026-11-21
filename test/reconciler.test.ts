import { describe, expect, it, vi } from 'vitest';
import type { RoleState } from '../src/api/website-client.js';
import { RoleReconciler } from '../src/sync/reconciler.js';

const guildId = '12345678901234567';
const userId = '23456789012345678';
const managedA = '34567890123456789';
const managedB = '45678901234567890';
const unmanaged = '56789012345678901';

function setup(
  state: Partial<RoleState> = {},
  current = [managedB, unmanaged],
  valid = [managedA, managedB, unmanaged],
) {
  const roleState: RoleState = {
    discord_user_id: userId,
    guild_id: guildId,
    linked: true,
    managed_role_ids: [managedA, managedB],
    desired_role_ids: [managedA],
    ...state,
  };
  const discord = {
    getMember: vi.fn(async () => ({
      roleIds: new Set(current),
      validGuildRoleIds: new Set(valid),
    })),
    addRoles: vi.fn(async () => undefined),
    removeRoles: vi.fn(async () => undefined),
    notifyRoleChange: vi.fn(async () => undefined),
  };
  return {
    reconciler: new RoleReconciler(guildId, discord, async () => roleState),
    discord,
  };
}

describe('RoleReconciler', () => {
  it('adds desired managed roles, removes undesired managed roles, and preserves unmanaged roles', async () => {
    const { reconciler, discord } = setup();
    expect(await reconciler.reconcile(userId)).toEqual({
      added: [managedA],
      removed: [managedB],
    });
    expect(discord.addRoles).toHaveBeenCalledWith(userId, [managedA]);
    expect(discord.removeRoles).toHaveBeenCalledWith(userId, [managedB]);
    expect(discord.removeRoles).not.toHaveBeenCalledWith(userId, [unmanaged]);
    expect(discord.notifyRoleChange).toHaveBeenCalledWith(userId, {
      added: [managedA],
      removed: [managedB],
    });
  });

  it('does nothing when roles already match or a user is unlinked', async () => {
    const matching = setup({}, [managedA, unmanaged]);
    expect(await matching.reconciler.reconcile(userId)).toEqual({
      added: [],
      removed: [],
    });
    expect(matching.discord.addRoles).not.toHaveBeenCalled();
    expect(matching.discord.removeRoles).not.toHaveBeenCalled();
    expect(matching.discord.notifyRoleChange).not.toHaveBeenCalled();

    const unlinked = setup({ linked: false, desired_role_ids: [] }, [
      managedA,
      managedB,
      unmanaged,
    ]);
    expect(await unlinked.reconciler.reconcile(userId)).toEqual({
      added: [],
      removed: [],
    });
    expect(unlinked.discord.getMember).not.toHaveBeenCalled();
    expect(unlinked.discord.addRoles).not.toHaveBeenCalled();
    expect(unlinked.discord.removeRoles).not.toHaveBeenCalled();
    expect(unlinked.discord.notifyRoleChange).not.toHaveBeenCalled();
  });

  it('removes all managed roles when a linked user has an empty desired set', async () => {
    const empty = setup({ desired_role_ids: [] }, [
      managedA,
      managedB,
      unmanaged,
    ]);
    expect(await empty.reconciler.reconcile(userId)).toEqual({
      added: [],
      removed: [managedA, managedB],
    });
  });

  it('rejects missing desired roles and propagates Discord failures as classified errors', async () => {
    const missing = setup({ desired_role_ids: [managedA] }, [], [managedB]);
    await expect(missing.reconciler.reconcile(userId)).rejects.toThrow(
      'missing from the configured guild',
    );

    const forbidden = setup();
    forbidden.discord.addRoles.mockRejectedValue({ code: 50013, status: 403 });
    await expect(forbidden.reconciler.reconcile(userId)).rejects.toThrow(
      'lacks permission',
    );
  });

  it('retries rate limits and server errors but not permanent Discord errors', async () => {
    const rateLimited = setup();
    rateLimited.discord.getMember.mockRejectedValue({ status: 429 });
    await expect(
      rateLimited.reconciler.reconcile(userId),
    ).rejects.toMatchObject({ retryable: true });

    const serverError = setup();
    serverError.discord.getMember.mockRejectedValue({ status: 503 });
    await expect(
      serverError.reconciler.reconcile(userId),
    ).rejects.toMatchObject({ retryable: true });

    const missingMember = setup();
    missingMember.discord.getMember.mockRejectedValue({
      code: 10007,
      status: 404,
    });
    await expect(
      missingMember.reconciler.reconcile(userId),
    ).rejects.toMatchObject({ retryable: false });

    const forbidden = setup();
    forbidden.discord.addRoles.mockRejectedValue({ code: 50013, status: 403 });
    await expect(forbidden.reconciler.reconcile(userId)).rejects.toMatchObject({
      retryable: false,
    });
  });
});
