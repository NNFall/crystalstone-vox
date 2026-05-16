# Crystal Stone Backend

Серверный слой для проекта `Crystal Stone`.

## Роль backend

Backend принимает события из Voximplant и централизует внешние интеграции:

1. хранит историю звонков в SQLite;
2. скачивает записи звонков;
3. отправляет отчеты в Telegram;
4. отправляет финальный payload в Google Apps Script.

## Основные endpoints

- `POST /webhook/voximplant/call_started`
- `POST /webhook/voximplant/call_finished`
- `POST /webhook/voximplant/recording_ready`
- `POST /webhook/voximplant/finalize`

Обратная совместимость (legacy):

- `POST /webhook/voximplant/report`
- `POST /webhook/voximplant/google_sheets`

Служебные:

- `GET /healthz`
- `GET /calls?secret=...&limit=...`
- `GET /calls/{session_id}?secret=...`

## Безопасность

- webhook-роуты защищены заголовком `X-Webhook-Secret`;
- секрет берется из `BACKEND_WEBHOOK_SECRET`;
- admin API (`/calls`) также закрыт этим секретом;
- записи не публикуются через открытый static route.

## Переменные окружения

См. `backend/.env.example`.

Основные:

- `BACKEND_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_USER_CHAT_IDS`
- `GOOGLE_APPS_SCRIPT_WEBHOOK_URL`
- `RECORDINGS_TTL_DAYS`
- `CLEANUP_INTERVAL_HOURS`

Надежность доставки:

- `DELIVERY_RETRY_ATTEMPTS`
- `DELIVERY_RETRY_DELAY_MS`
- `DOWNLOAD_RETRY_ATTEMPTS`
- `DOWNLOAD_RETRY_DELAY_MS`

## Локальный запуск

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

## Примечания

- Если `TELEGRAM_BOT_TOKEN` не задан, backend продолжает работать, но Telegram-доставка отключена.
- Если `GOOGLE_APPS_SCRIPT_WEBHOOK_URL` пустой, синхронизация в таблицу будет помечаться как `skipped_no_url`.
