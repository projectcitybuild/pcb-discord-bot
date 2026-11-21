import {
  Client,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type {
  DiscordMemberSnapshot,
  DiscordRoleGateway,
  ReconcileResult,
} from '../sync/reconciler.js';
import { formatAccountEventMessage, formatRoleChangeMessage } from './messages.js';

export class DiscordGateway implements DiscordRoleGateway {
  readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.client.on('error', (error) =>
      this.logger.error({ err: error }, 'Discord client error'),
    );
    this.client.on('shardDisconnect', (event, shardId) => {
      this.logger.warn(
        { shardId, code: event.code },
        'Discord gateway disconnected',
      );
    });
    this.client.on('shardReconnecting', (shardId) =>
      this.logger.info({ shardId }, 'Discord gateway reconnecting'),
    );
    this.client.on('interactionCreate', (interaction) => {
      if (
        !interaction.isChatInputCommand() ||
        interaction.commandName !== 'connect'
      ) {
        return;
      }

      void this.handleConnectCommand(interaction).catch((error: unknown) =>
        this.logger.error({ err: error }, 'Discord connect command failed'),
      );
    });
    this.client.once('ready', () => {
      this.logger.info(
        {
          guildId: this.config.DISCORD_GUILD_ID,
          botUserId: this.client.user?.id,
        },
        'Discord client ready',
      );
      void this.registerCommands().catch((error: unknown) =>
        this.logger.error({ err: error }, 'Could not register Discord commands'),
      );
    });
  }

  async start(): Promise<void> {
    this.logger.info('Connecting Discord client');
    await this.client.login(this.config.DISCORD_BOT_TOKEN);
  }

  private async registerCommands(): Promise<void> {
    await this.client.application?.commands.create(
      {
        name: 'connect',
        description: 'Link your Discord account to your PCB account',
      },
      this.config.DISCORD_GUILD_ID,
    );
  }

  private async handleConnectCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const connectUrl = this.config.WEB_DISCORD_CONNECT_URL;
    await interaction.deferReply({ ephemeral: true });

    try {
      await interaction.user.send(
        `Connect your Discord account to your PCB account: ${connectUrl}`,
      );
      await interaction.editReply('I sent you a private message with the link.');
    } catch (error) {
      this.logger.warn(
        { discordUserId: interaction.user.id, err: error },
        'Could not DM Discord connect link; returning it privately',
      );
      await interaction.editReply(
        `I could not send you a DM. Use this private link instead: ${connectUrl}`,
      );
    }
  }

  async getMember(discordUserId: string): Promise<DiscordMemberSnapshot> {
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);

    if (guild.id !== this.config.DISCORD_GUILD_ID) {
      throw new Error('Discord guild mismatch');
    }

    const [member, roles] = await Promise.all([
      guild.members.fetch({ user: discordUserId, force: true }),
      guild.roles.fetch(),
    ]);
    
    return {
      roleIds: new Set(member.roles.cache.keys()),
      validGuildRoleIds: new Set(roles.keys()),
    };
  }

  async addRoles(discordUserId: string, roleIds: string[]): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID)
    const member = await guild.members.fetch({ 
        user: discordUserId, 
        force: true,
    });
    await member.roles.add(
      roleIds,
      'PCB website role synchronization',
    );
  }

  async removeRoles(discordUserId: string, roleIds: string[]): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID)
    const member = await guild.members.fetch({ 
        user: discordUserId, 
        force: true,
    });
    await member.roles.remove(
      roleIds,
      'PCB website role synchronization',
    );
  }

  async notifyRoleChange(
    discordUserId: string,
    change: ReconcileResult,
  ): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(this.config.DISCORD_GUILD_ID);
      const roles = await guild.roles.fetch();
      const user = await this.client.users.fetch(discordUserId);
      const added = change.added.map(
        (roleId) => roles.get(roleId)?.name ?? roleId,
      );
      const removed = change.removed.map(
        (roleId) => roles.get(roleId)?.name ?? roleId,
      );
      await user.send(formatRoleChangeMessage(added, removed));
    } catch (error) {
      this.logger.warn(
        { discordUserId, err: error },
        'Could not send Discord role change notification',
      );
    }
  }

  async notifyAccountEvent(
    discordUserId: string,
    event: 'linked' | 'disconnected',
  ): Promise<void> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(formatAccountEventMessage(event));
    } catch (error) {
      this.logger.warn(
        { discordUserId, event, err: error },
        'Could not send Discord account notification',
      );
    }
  }

  isReady(): boolean {
    return this.client.isReady();
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}
