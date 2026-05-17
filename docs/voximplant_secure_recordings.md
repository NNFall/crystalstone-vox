# Secure записи Voximplant: как настроено в проекте

Этот гайд про скачивание записей, когда ссылка вида `voximplant-records-secure/...` возвращает `401 Authorization failed`.

## Проблема

Без авторизации secure-ссылка записи не отдается:

- HTTP 401
- тело ответа: `Authorization failed`

## Решение

Использовать Service Account JSON от Voximplant и подписывать запрос `Authorization: Bearer <jwt>`.

В проекте это уже реализовано в `backend/main.py` через библиотеку `voximplant-apiclient`.

## Что нужно сделать

1. Создать Service Account в Voximplant и скачать JSON key.
2. Положить JSON на сервер, например:
   - `/root/crystalstone/backend/keys/voximplant_service_account.json`
3. Поставить права на файл:

```bash
chmod 600 /root/crystalstone/backend/keys/voximplant_service_account.json
```

4. Указать в `backend/.env`:

```env
VOXIMPLANT_CREDENTIALS_FILE_PATH=/app/backend/keys/voximplant_service_account.json
```

5. Пересобрать backend:

```bash
cd /root/crystalstone
docker compose up -d --build
```

## Что делает backend в коде

- Инициализирует `VoximplantAPI(VOXIMPLANT_CREDENTIALS_FILE_PATH)`.
- Для URL с `voximplant-records-secure` добавляет заголовок:

```python
Authorization: Bearer <jwt from build_auth_header()>
```

- Скачивает файл и сохраняет в `/app/backend/recordings/<session_id>.mp3`.

## Быстрая ручная проверка (Python)

```python
import requests
from voximplant.apiclient import VoximplantAPI

api = VoximplantAPI('/path/to/service_account.json')
headers = {'Authorization': api.build_auth_header()}

url = 'https://...voximplant-records-secure...'
r = requests.get(url, headers=headers, timeout=30)
print(r.status_code, r.headers.get('content-type'), len(r.content))
```

Ожидаемо при успехе:

- `200`
- `audio/mpeg`
- размер > 0

## Где смотреть результат

- Файлы: `/root/crystalstone/backend/recordings`
- Логи контейнера:

```bash
cd /root/crystalstone
docker compose logs -f crystalstone-backend
```

## Полезные ссылки

- Secure objects / secure recordings:  
  https://voximplant.kz/docs/guides/management-api/secure-objects
- Management API / service account:  
  https://voximplant.kz/docs/getting-started/basic-concepts/management-api
- Параметры приложения (`secureRecordStorage`):  
  https://voximplant.com/docs/references/voxengine/voximplantapi/addapplicationrequest
