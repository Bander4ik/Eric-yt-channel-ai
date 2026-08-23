# YouTube Channel AI VIP — рабочий контекст

Этот файл — краткая карта проекта для следующих сессий Codex/разработчиков.

## Что это за проект

Локальное Next.js-приложение для аналитики YouTube-каналов и AI-помощи автору.
Приложение запускается на компьютере пользователя и открывается в браузере.

Основные возможности:

- синхронизация одного или нескольких YouTube-каналов;
- Dashboard с просмотрами, watch time, подписчиками, аудиторией, трафиком и доходом;
- таблица видео, комментарии, транскрипты и категории;
- Competitors и alerts для анализа конкурентов;
- AI Chat с инструментами чтения данных из локальной базы;
- Hook Lab для анализа первых 30–60 секунд видео;
- Ideation: Board, Videos, Packaging, Signals и Thumbnails;
- генерация обложек по стилю успешных видео канала и конкурентов.

## Репозитории и локальный путь

- Рабочая локальная копия: `/Users/wozglas/Documents/ChatGPT/eric ai youtube`
- Git remote: `https://github.com/PrettyShitter/eric-documentary-video`
- Основная ветка: `main`
- Исходный проект: `https://github.com/YT-Wizards/YouTube-Channel-AI-VIP`
- Импорт выполнен коммитом `40eccd8`.

Все дальнейшие изменения нужно делать в локальной копии и затем отправлять в `origin/main`.

## Стек и команды

- Node.js 20+
- Next.js 16.2.4, App Router, React 19, TypeScript
- SQLite через `better-sqlite3`
- Tailwind CSS v4

```bash
npm ci
npm run dev
npm run build
npm start
```

В этой среде порт `3000` занят OrbStack, поэтому dev-сервер запускался на `3001`:

```bash
npm run dev -- -p 3001
```

Проверка работоспособности:

```bash
curl http://localhost:3001/api/health
```

Production-сборка и browser-проверка уже проходили успешно. Отдельного test script в `package.json` нет.

## Данные и секреты

По умолчанию база находится здесь:

`~/.youtube-channel-ai-vip/app.db`

Путь можно изменить переменной `DATA_DIR`. В базе хранятся ключи интеграций, OAuth-токены, история чатов, транскрипты, кеш аналитики и настройки. Не коммитить локальную базу, `.env` и пользовательские ключи.

Подключаемые сервисы:

- YouTube Data API — каналы, видео, просмотры, комментарии;
- Google OAuth / YouTube Analytics — Studio-метрики и доход;
- Claude или Gemini — AI-чат и анализ;
- Deepgram — платная транскрибация, если нет субтитров YouTube;
- Apify — fallback для части competitor-сценариев;
- Gemini, OpenAI, fal или kie.ai — генерация изображений.

## Архитектурные правила

- Данные изолируются по активному каналу.
- Долгие операции работают как server-side jobs с прогрессом в SQLite.
- Синхронизация и транскрибация используют взаимные блокировки, чтобы не повредить SQLite.
- Статистические правила должны считаться из SQL; AI объясняет данные, но не заменяет расчёты.
- Для Next.js-изменений сначала учитывать правила в `AGENTS.md` и актуальную документацию Next.js 16.

## Ближайшие задачи

### NexLev в Research → Competitors

Клиент хочет использовать NexLev как дополнительный источник для:

- поиска новых outlier-каналов/потенциальных конкурентов;
- поиска новых outlier-видео;
- возможного импорта найденных результатов в существующий workflow Competitors.

Нужно уточнить, искать ли конкурентов относительно активного канала или по заданной нише, и что означает «new»: новые с момента последнего sync или отсутствующие в локальной базе.

NexLev также может возвращать транскрипты. Это потенциальный следующий этап для Hook Lab, но не обязательная часть первой интеграции.

### Ошибка Signals → Audience requests → Generate title

Сообщение `AI returned unparseable output — try again` означает, что запрос Claude завершился, но ответ не прошёл JSON-парсинг в `src/app/api/signals/generate-title/route.ts`.

Это, вероятнее всего, проблема устойчивости приложения, а не отсутствие ключа пользователя. При повторении нужно логировать сырой ответ модели и улучшить structured JSON/повторную попытку.

## Важные файлы

- `src/lib/db.ts` — SQLite, схема и доступ к данным;
- `src/lib/youtube.ts` — YouTube Data API;
- `src/lib/yt-analytics.ts` — YouTube Analytics API;
- `src/lib/chat-tools.ts` — инструменты AI-чата;
- `src/lib/competitor-sync.ts` — синхронизация конкурентов;
- `src/app/api/signals/generate-title/route.ts` — генерация названий из Signals;
- `src/lib/hook-analyzer.ts` — Hook Lab;
- `src/lib/thumbnail-style.ts` и `src/lib/thumbnail-generate.ts` — стиль и генерация обложек;
- `src/app/ideation/page.tsx` — вкладки Ideation.

## Рабочий процесс

1. Проверить `git status` и не затрагивать чужие незакоммиченные изменения.
2. Для новой функции определить API route, слой базы и UI-компонент.
3. Запустить подходящую проверку (`npm run build`, endpoint или browser check).
4. Закоммитить только относящиеся к задаче файлы.
5. Отправить изменения в `origin/main` только после проверки.
