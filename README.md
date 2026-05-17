# Crystal Stone (Voximplant + Gemini Live)

Проект голосового AI-менеджера для входящих звонков.  
Текущая рабочая схема: Voximplant сценарий -> backend (FastAPI) -> Telegram + Google Sheets + локальное хранилище записей.

## Что уже реализовано

- Голосовой сценарий на Voximplant с Gemini Live.
- Function calling (`save_call_summary`) и финализация звонка в backend.
- Централизованные интеграции в backend:
  - Telegram уведомления;
  - отправка данных в Google Apps Script / Google Sheets;
  - сохранение истории звонка в SQLite;
  - скачивание записи разговора на сервер;
  - очистка старых записей по TTL.

## Ключевые файлы

- `crystalstone_server_edition.js` — основной сценарий с серверной архитектурой.
- `crystalstone_2_5_flash.js` — прямой сценарий (legacy/тесты).
- `backend/main.py` — backend API и интеграции.
- `backend/database.py` — модель БД и инициализация SQLite.
- `backend/README.md` — подробная backend-документация.
- `docs/voximplant_secure_recordings.md` — secure-доступ к записям.
- `PROJECT_WORKLOG.md` — журнал изменений и решений.

## Быстрый запуск backend в Docker

```bash
cd /root/crystalstone
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8000/healthz
```

## Что нужно указать в Voximplant ApplicationStorage

Минимум:

- `GEMINI_API_KEY` (или один из альтернативных ключей в сценарии)
- `BACKEND_URL` — например `http://186.246.18.100:8000`
- `BACKEND_WEBHOOK_SECRET`

## Как работает запись разговора

1. Voximplant присылает `recording_url` в событиях/финализации.
2. Backend сохраняет ссылку в БД.
3. Backend пытается скачать файл в `backend/recordings/`.
4. Если secure storage включен, используется service account JSON (`VOXIMPLANT_CREDENTIALS_FILE_PATH`).
5. Планировщик удаляет старые записи по `RECORDINGS_TTL_DAYS`.

Подробно: [backend/README.md](./backend/README.md) и [docs/voximplant_secure_recordings.md](./docs/voximplant_secure_recordings.md)

## Полезные ссылки на документацию

- Secure objects / secure recordings (Voximplant):  
  https://voximplant.kz/docs/guides/management-api/secure-objects
- Management API basic concepts / service accounts:  
  https://voximplant.kz/docs/getting-started/basic-concepts/management-api
- Параметры приложения (`secureRecordStorage`):  
  https://voximplant.com/docs/references/voxengine/voximplantapi/addapplicationrequest

## Важно по секретам

Не коммитить в git:

- `backend/.env`
- `backend/keys/*.json`
- `backend/recordings/*`
- `backend/voximplant.db`
