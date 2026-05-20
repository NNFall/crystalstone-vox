# Crystal Stone Backend

FastAPI backend, который принимает события от Voximplant и централизует интеграции.

## Роль backend

- принимает lifecycle-события звонка;
- хранит данные звонков в SQLite;
- формирует и отправляет отчеты в Telegram;
- отправляет запись звонка отдельным аудиофайлом в Telegram ответом на сообщение со сводкой;
- отправляет payload в Google Apps Script (Google Sheets);
- скачивает аудиозапись звонка локально на сервер;
- очищает старые записи по TTL.

## Основные endpoints

### Webhooks Voximplant

- `POST /webhook/voximplant/call_started`
- `POST /webhook/voximplant/call_finished`
- `POST /webhook/voximplant/recording_ready`
- `POST /webhook/voximplant/finalize` (основной финальный endpoint)

### Legacy (обратная совместимость)

- `POST /webhook/voximplant/report`
- `POST /webhook/voximplant/google_sheets`

### Служебные

- `GET /healthz`
- `GET /calls?secret=...&limit=...`
- `GET /calls/{session_id}?secret=...`

## Безопасность

- Webhook-роуты защищены заголовком `X-Webhook-Secret`.
- Секрет берется из `BACKEND_WEBHOOK_SECRET`.
- Админ-чтение `/calls` также требует этот секрет.

## Переменные окружения

Смотри `.env.example`.

Ключевые:

- `BACKEND_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_USER_CHAT_IDS`
- `GOOGLE_APPS_SCRIPT_WEBHOOK_URL`
- `RECORDINGS_TTL_DAYS`
- `CLEANUP_INTERVAL_HOURS`
- `DELIVERY_RETRY_ATTEMPTS`
- `DELIVERY_RETRY_DELAY_MS`
- `DOWNLOAD_RETRY_ATTEMPTS`
- `DOWNLOAD_RETRY_DELAY_MS`
- `VOXIMPLANT_CREDENTIALS_FILE_PATH` (для secure-записей)

## Записи звонков: логика хранения

### Куда сохраняются

Локальная папка в контейнере: `/app/backend/recordings`  
На хосте (при bind mount): `/root/crystalstone/backend/recordings`

### Как скачиваются

1. При `recording_ready` или `finalize` backend получает `recording_url`.
2. Если URL обычный — скачивает напрямую.
3. Если URL из `voximplant-records-secure` и задан `VOXIMPLANT_CREDENTIALS_FILE_PATH`:
   - backend создает `Authorization: Bearer ...` через `voximplant-apiclient`;
   - скачивает запись уже авторизованно.
4. После отправки Telegram-сводки backend отправляет локальный mp3-файл ответом на это же сообщение.
5. Если ссылка на запись пришла позже финализации звонка, backend использует сохраненный `message_id` сводки и досылает запись отдельным reply-сообщением.

### Очистка

Планировщик (`apscheduler`) удаляет старые файлы по `RECORDINGS_TTL_DAYS`.

## Быстрый deploy (Docker)

```bash
cd /root/crystalstone
docker compose up -d --build
docker compose ps
docker compose logs -f crystalstone-backend
```

## Проверки после деплоя

```bash
curl http://127.0.0.1:8000/healthz
```

Проверка финализации:

```bash
curl -X POST http://127.0.0.1:8000/webhook/voximplant/finalize \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <SECRET>" \
  -d '{"session_id":"test-session","project":"crystal_stone"}'
```

## Частые проблемы

### `google_sheets_status = skipped_no_url`

Не задан `GOOGLE_APPS_SCRIPT_WEBHOOK_URL`.

### `Authorization failed` при скачивании записи

Не настроен service account для secure storage, либо не задан путь `VOXIMPLANT_CREDENTIALS_FILE_PATH`, либо недостаточно прав у аккаунта.

Подробный гайд: [docs/voximplant_secure_recordings.md](../docs/voximplant_secure_recordings.md)
