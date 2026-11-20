# PCB Discord Bot

This service syncs website roles to one Discord guild. The PCB API is the source of truth - the bot merely fetches role state and changes roles listed in `managed_role_ids`.

## Setup

- Install mise and Docker Compose v2. Run `mise install` to install the pinned Node.js and bundled npm versions.
- Create a Discord bot. Enable the **Server Members Intent**. Grant `Manage Roles` in the target guild. Place the bot's highest role above all managed roles.
- Create a Laravel Passport client for `client_credentials` and grant the `discord.roles.sync` scope.
- Set the bot's guild ID to the same ID as Laravel's. Set `WEB_API_BASE_URL` to Laravel's API host, without a path.
- Set Laravel's `DISCORD_BOT_CALLBACK_URL` and `DISCORD_CALLBACK_SECRET`. The secret must match `WEBHOOK_SECRET`.
- Copy `.env.example` to `.env` and set the required values.

Laravel sends `POST /webhooks/discord/role-sync` with `discord_user_id` and `sync_id`. It signs the exact JSON body with HMAC-SHA256 over `${timestamp}.${body}`. The bot checks `X-Discord-Timestamp`, `X-Discord-Signature`, and `Idempotency-Key`.

The bot reads `GET /v3/discord/users/{discordUserId}/roles` using the `discord.roles.sync` scope. It gets an OAuth token from `/oauth/token`. Laravel must use HTTPS for callbacks outside local/testing. In production, route a private HTTPS hostname or proxy to the bot over the Docker network.

## Run locally

```sh
npm ci
cp .env.example .env
npm run dev
```

Run checks:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

## Run with Docker

Set `WEB_NETWORK` to the existing private Docker network shared with Laravel:

```sh
export WEB_NETWORK=your-web-network
cp .env.example .env
# Set the secrets and service values in .env.
docker compose up -d --build
docker compose logs -f pcb-discord-bot
```

Compose does not publish a host port. Laravel can reach the service as `pcb-discord-bot:3000`. SQLite data is stored in the `discord-bot-data` volume. Check health at `/health` from the Docker network; the endpoint returns `503` until Discord is ready.

This service uses one instance and a local SQLite volume. Do not run multiple replicas or share the database between hosts.
