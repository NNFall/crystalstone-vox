# Crystal Stone Backend

Серверный слой для проекта `Crystal Stone`.

## Задача backend

Backend принимает события от Voximplant, хранит историю звонков, скачивает записи, отправляет уведомления в Telegram и синхронизирует финальные данные в Google Sheets.

Целевая схема:

1. Voximplant ведет звонок и собирает итоговый payload.
2. Voximplant отправляет lifecycle-события и финальный webhook только в backend.
3. Backend:
   - сохраняет историю звонка в SQLite;
   - скачивает запись звонка локально;
   - отправляет сообщения в Telegram;
   - проксирует финальный payload в Google Apps Script.

## Основные endpoints

- `POST /webhook/voximplant/call_started`
- `POST /webhook/voximplant/call_finished`
- `POST /webhook/voximplant/recording_ready`
- `POST /webhook/voximplant/finalize`

Для обратной совместимости пока оставлены:

- `POST /webhook/voximplant/report`
- `POST /webhook/voximplant/google_sheets`

Служебные:

- `GET /healthz`
- `GET /calls?secret=...`

## Переменные окружения

См. `backend/.env.example`.

Обязательные / рабочие:

- `BACKEND_WEBHOOK_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_USER_CHAT_IDS`
- `GOOGLE_APPS_SCRIPT_WEBHOOK_URL`

Дополнительно:

- `RECORDINGS_TTL_DAYS`
- `CLEANUP_INTERVAL_HOURS`
- `DATABASE_URL` — если нужно переопределить путь к SQLite

## Хранение данных

SQLite-таблица `calls` хранит:

- идентификатор звонка;
- телефоны и имя клиента;
- модель и имя сценария;
- длительность и стоимости;
- summary, goal, outcome, next step;
- текст диалога;
- статусы Telegram / Google Sheets;
- URL записи и локальный путь;
- raw JSON итогового payload.

## Локальный запуск

```bash
cd backend
python -m venv venv
venv\\Scripts\\activate
pip install -r requirements.txt
python main.py
```

Или:

```bash
cd backend
start.sh
```

## Замечания

- Записи больше не публикуются как открытая директория.
- `GET /calls` защищен общим секретом.
- Если `TELEGRAM_BOT_TOKEN` не задан, сервер продолжает работать, но Telegram-доставка отключается.
