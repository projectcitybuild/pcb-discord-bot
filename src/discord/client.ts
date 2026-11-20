import { Client, GatewayIntentBits } from 'discord.js';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type {
  DiscordMemberSnapshot,
  DiscordRoleGateway,
} from '../sync/reconciler.js';

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
    this.client.once('ready', () => {
      this.logger.info(
        {
          guildId: this.config.DISCORD_GUILD_ID,
          botUserId: this.client.user?.id,
        },
        'Discord client ready',
      );
    });
  }

  async start(): Promise<void> {
    this.logger.info('Connecting Discord client');
    await this.client.login(this.config.DISCORD_BOT_TOKEN);
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

  isReady(): boolean {
    return this.client.isReady();
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}
