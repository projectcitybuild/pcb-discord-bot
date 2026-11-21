# PCB Discord Bot

This service syncs website roles to one Discord guild. The PCB API is the source of truth - the bot merely fetches role state and changes roles listed in `managed_role_ids`.

## Setup

- Install mise and Docker Compose v2. Run `mise install` to install the pinned Node.js and bundled npm versions.
- Create a Discord bot. Enable the **Server Members Intent**. Grant `Manage Roles` in the target guild. Place the bot's highest role above all managed roles.
- Copy `.env.example` to `.env` and set the required values.

### Configure .env variables

| Variable | Source/purpose |
| --- | --- |
| `WEB_NETWORK` | Network of the API web server container. This bot should be run on the same network so that it can communicate |
| `WEBHOOK_SECRET` | Secret set in the web server's .env. This is used to prove that an incoming webhook HTTP request is from the web server. |
| `WEB_API_BASE_URL` | API web server container's host. Must be reachable from within the bot container |
| `WEB_API_HOST_HEADER` | If that hostname differs from Laravel's API route domain, set to the route domain (for example, `api.localhost`). |
| `WEB_DISCORD_CONNECT_URL` | Public website URL for the Discord account connect route (`/account/settings/discord/connect`). |
| `WEB_API_CLIENT_ID` | Passport client ID |
| `WEB_API_CLIENT_SECRET` | Passport client secret |
| `WEB_API_SCOPE` | OAuth scope |

## Run locally

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
