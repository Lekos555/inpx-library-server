# Кэширование через nginx для NAS Synology

## Что это даст

| Без nginx | С nginx кэшем |
|-----------|---------------|
| Каждый запрос лезет в SQLite | Страница отдаётся из памяти |
| 10 пользователей — предел | 30–50 пользователей — норма |
| Обложки генерируются заново | Обложки кэшируются на неделю |
| Задержка 1–4 сек | Задержка 5–20 мс (если в кэше) |

## Как работает

```
Пользователь → nginx (проверяет кэш) → [если нет] → Node.js → SQLite
                        ↓
                   [если есть] → отдаёт мгновенно
```

## Вариант 1. Быстрый: через Container Manager (Docker)

### Шаг 1. Создай папку для конфигов

На NAS через File Station:
```
/docker/inpx-nginx/
  └── nginx.conf   ← сюда положить файл из docker/nginx/nginx.conf
```

### Шаг 2. Создай docker-compose.yml

В той же папке `/docker/inpx-nginx/` создай файл `docker-compose.yml`:

```yaml
services:
  app:
    image: ghcr.io/habsaec/inpx-library-server:latest
    container_name: inpx-app
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3000
      - LIBRARY_PATH=/library
      - SQLITE_PATH=/data
      - SESSION_SECRET=замени-на-свой-секретный-ключ
      - ANONYMOUS_DOWNLOAD=true
    volumes:
      - /volume1/books:/library:ro
      - /volume1/docker/inpx/data:/data
    expose:
      - "3000"
    networks:
      - inpx-net

  nginx:
    image: nginx:alpine
    container_name: inpx-nginx
    restart: unless-stopped
    ports:
      - "3000:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - nginx-cache:/var/cache/nginx
    networks:
      - inpx-net
    depends_on:
      - app

networks:
  inpx-net:
    driver: bridge

volumes:
  nginx-cache:
```

**Важно:**
- Замени `/volume1/books` на путь к своей папке с книгами
- Замени `SESSION_SECRET` на любую длинную строку (случайные буквы и цифры)

### Шаг 3. Запусти через Container Manager

1. Открой **Container Manager** (DSM)
2. Перейди в **Проект**
3. Нажми **Создать**
4. **Путь к проекту**: `/docker/inpx-nginx`
5. **Имя**: `inpx-nginx`
6. Нажми **Далее → Готово**
7. Контейнеры запустятся автоматически

### Шаг 4. Проверь

Открой в браузере:
```
http://192.168.1.30:3000
```

Открой DevTools (F12) → вкладка **Network** → обнови страницу.

В ответе от сервера ищи заголовок:
```
X-Cache-Status: HIT    ← значит работает кэш
X-Cache-Status: MISS   ← первый запрос, положил в кэш
```

---

## Вариант 2. Ручная настройка в DSM (без Docker)

Synology DSM уже имеет встроенный nginx, но его сложно настроить для кэширования. Рекомендуется Вариант 1.

Если хочешь именно встроенный nginx:

1. **Панель управления → Входящий трафик → Обратный прокси-сервер**
2. Создай правило:
   - **Имя**: inpx-cache
   - **Источник**: HTTP, порт 3000
   - **Назначение**: HTTP, `localhost:3001` (где работает inpx-library-server)
3. Кэширование в встроенном nginx DSM **ограничено** — можно включить только базовое кэширование через SSH:

```bash
# Подключись к NAS по SSH (админ)
sudo -i
# Редактируй конфиг nginx DSM
vi /etc/nginx/nginx.conf
```

Но после обновления DSM настройки сбросятся. **Рекомендуется Docker.**

---

## Что кэшируется и на сколько

| Ресурс | TTL | Пояснение |
|--------|-----|-----------|
| HTML-страницы | 5 мин | Главная, каталог, книга, библиотека |
| CSS/JS/шрифты | 1 день | Статические ассеты |
| Обложки | 7 дней | `/api/books/*/cover*` |
| API | не кэшируется | `/api/*`, `/login`, `/profile` |
| OPDS | не кэшируется | Динамические фиды |

---

## Очистка кэша

Если что-то отображается неправильно:

```bash
# Через SSH на NAS
docker exec inpx-nginx rm -rf /var/cache/nginx/*
```

Или перезапусти контейнер nginx:
```bash
docker restart inpx-nginx
```

---

## Проверка эффекта

Перезапусти нагрузочный тест **после** включения nginx:

```bash
node bench/load-test.cjs http://192.168.1.30:3000 --phases=10,20,30
```

Обычно результат:
- **10 пользователей**: было 1.9 с → станет 50–200 мс
- **20 пользователей**: было 4.2 с → станет 100–300 мс
- **30 пользователей**: было 83% ошибок → станет 0 ошибок

---

## Безопасность

Конфиг уже настроен так, чтобы **НЕ кэшировать** персональные данные:
- Страницы с куками авторизации (`session`, `auth`) — всегда свежие
- `/api/*`, `/login`, `/profile`, `/shelves`, `/favorites` — без кэша
- Анонимные пользователи получают кэшированные страницы
- Авторизованные — персональные (прочитано, избранное и т.д.)
