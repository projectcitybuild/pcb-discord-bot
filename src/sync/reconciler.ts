import type { RoleState } from '../api/website-client.js';
import { SyncFailure, classifyDiscordError } from '../errors.js';

export type DiscordMemberSnapshot = {
  roleIds: ReadonlySet<string>;
  validGuildRoleIds: ReadonlySet<string>;
};

export interface DiscordRoleGateway {
  getMember(discordUserId: string): Promise<DiscordMemberSnapshot>;
  addRoles(discordUserId: string, roleIds: string[]): Promise<void>;
  removeRoles(discordUserId: string, roleIds: string[]): Promise<void>;
  notifyRoleChange(
    discordUserId: string,
    change: ReconcileResult,
  ): Promise<void>;
}

export type ReconcileResult = { added: string[]; removed: string[] };

export class RoleReconciler {
  constructor(
    private readonly guildId: string,
    private readonly discord: DiscordRoleGateway,
    private readonly getRoleState: (
      discordUserId: string,
    ) => Promise<RoleState>,
  ) {}

  async reconcile(discordUserId: string): Promise<ReconcileResult> {
    const state = await this.getRoleState(discordUserId);
    if (state.guild_id !== this.guildId)
      throw new SyncFailure(
        'Website API guild does not match configured Discord guild',
        false,
      );
    if (state.discord_user_id !== discordUserId)
      throw new SyncFailure(
        'Website API returned a different Discord user',
        false,
      );
    if (!state.linked) return { added: [], removed: [] };

    const managed = new Set(state.managed_role_ids);
    const desired = new Set(state.desired_role_ids);
    for (const roleId of desired) {
      if (!managed.has(roleId))
        throw new SyncFailure(
          'Desired Discord role is not managed by the website',
          false,
        );
    }

    let member: DiscordMemberSnapshot;
    try {
      member = await this.discord.getMember(discordUserId);
    } catch (error) {
      throw classifyDiscordError(error);
    }

    const invalidDesired = [...desired].filter(
      (roleId) => !member.validGuildRoleIds.has(roleId),
    );
    if (invalidDesired.length > 0)
      throw new SyncFailure(
        'Website references a Discord role that is missing from the configured guild',
        false,
      );

    const additions = [...desired].filter(
      (roleId) => !member.roleIds.has(roleId),
    );
    const removals = [...managed].filter(
      (roleId) => member.roleIds.has(roleId) && !desired.has(roleId),
    );
    try {
      if (additions.length > 0)
        await this.discord.addRoles(discordUserId, additions);
      if (removals.length > 0)
        await this.discord.removeRoles(discordUserId, removals);
    } catch (error) {
      throw classifyDiscordError(error);
    }
    if (additions.length > 0 || removals.length > 0)
      await this.discord.notifyRoleChange(discordUserId, {
        added: additions,
        removed: removals,
      });
    return { added: additions, removed: removals };
  }
}
