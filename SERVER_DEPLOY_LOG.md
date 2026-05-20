# Server Deploy Log (crystal_stone)

## 2026-05-20

### Scope
- Fix Telegram delivery format for Crystal Stone call summaries.
- Improve messenger handling in `crystalstone_server_edition.js`.
- Deploy backend changes to `root@186.246.18.100:/root/crystalstone`.

### Done
- Removed recording link from summary Telegram message.
- Changed summary title to `Новый звонок (суммаризация) - Crystal Stone`.
- Added backend delivery of the local mp3 recording as a Telegram audio reply to the summary message.
- Added DB columns for saved summary `message_id` values and Telegram recording delivery status.
- Added fallback path: if `recording_ready` arrives after summary delivery, backend sends the recording reply later using the stored message IDs.
- Updated prompt rules so MAX/Макс is not replaced with WhatsApp in answers, `next_step`, or `summary`.
- Rebuilt and restarted Docker service:
  - `docker compose up -d --build`
- Validated runtime:
  - `GET /healthz` -> ok
  - DB migration created new Telegram recording columns
  - `Bot.send_audio` supports `reply_parameters`
  - secure Voximplant recording download works with the configured service account.

## 2026-05-16

### Scope
- SSH deploy to `root@186.246.18.100:22`
- Target folder: `/root/crystalstone`
- Run backend in Docker with bind-mount of external files

### Done
- Verified Docker and Docker Compose v2 on server.
- Synced deploy files to server:
  - `Dockerfile`
  - `docker-compose.yml`
  - `backend/*`
- Confirmed bind-mount mode in compose:
  - `./backend:/app/backend`
- Rebuilt and restarted service:
  - `docker compose up -d --build`
- Validated runtime:
  - `docker compose ps` -> container is `Up`
  - `GET /healthz` -> `{"ok":true,...}`
- Restored webhook secret in server `.env` after sync overwrite.
- Validated webhook protection:
  - no secret -> `403`
  - wrong secret -> `403`
  - correct secret -> `200`

### Notes
- Keep server secret only in `/root/crystalstone/backend/.env`.
- Do not commit production `.env` into git.
