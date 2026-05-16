# Server Deploy Log (crystal_stone)

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
