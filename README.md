# Crystal Stone

Папка проекта для голосового AI-агента `Crystal Stone` на Voximplant + Gemini Live.

## Основные сценарии

- `crystalstone_2_5_flash.js` — стабильный сценарий с прямыми интеграциями
- `crystalstone.js` — альтернативный сценарий на Gemini 3.1 Live
- `crystalstone_server_edition.js` — сценарий для серверной архитектуры, где внешние интеграции идут через backend

## Серверная часть

- `backend/` — FastAPI backend
- `google_apps_script_calls_webhook.js` — Google Apps Script для таблицы звонков
- `PROJECT_WORKLOG.md` — основной журнал работ и решений по проекту
- `MIGRATION_PLAN.md` — ранний план миграции

## Текущее направление

Основная архитектура сейчас такая:

1. Voximplant ведет звонок и собирает итоговый payload.
2. `crystalstone_server_edition.js` отправляет lifecycle-события и финальный webhook только в backend.
3. Backend уже сам:
   - пишет историю в SQLite;
   - скачивает записи;
   - шлет уведомления в Telegram;
   - синхронизирует данные в Google Sheets.

## ApplicationStorage для server edition

- `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_KEY` / `GOOGLE_GEMINI_API_KEY`
- `BACKEND_URL`
- `BACKEND_WEBHOOK_SECRET` или `BACKEND_SHARED_SECRET`

## Backend `.env`

См. `backend/.env.example`.

## Дальнейшая работа

Текущий активный журнал и план ведутся в `PROJECT_WORKLOG.md`.
