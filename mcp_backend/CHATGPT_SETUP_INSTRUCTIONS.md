# 🚀 Подключение к ChatGPT Web - Пошаговая Инструкция

Эта инструкция поможет подключить SecondLayer MCP backend к ChatGPT web интерфейсу.

## ✅ Что Было Сделано

### 1. Создан MCP SSE Server
- ✅ Файл: `src/api/mcp-sse-server.ts`
- ✅ Протокол: MCP over Server-Sent Events (SSE)
- ✅ Формат: JSON-RPC 2.0
- ✅ Все 41 инструмент доступны через MCP

### 2. Добавлены Новые Endpoints
- ✅ `POST /sse` - MCP SSE endpoint для ChatGPT
- ✅ `GET /mcp` - Discovery endpoint (список инструментов)

### 3. Создана Документация
- ✅ `CHATGPT_QUICKSTART.md` - Быстрый старт (5 минут)
- ✅ `docs/CHATGPT_INTEGRATION.md` - Полная документация
- ✅ `docs/DEPLOYMENT_CHATGPT.md` - Руководство по деплою
- ✅ `EXAMPLES_CHATGPT.md` - 10 примеров использования
- ✅ `CHANGELOG_CHATGPT.md` - История изменений

### 4. Конфигурация Nginx
- ✅ `nginx-mcp-chatgpt.conf` - Готовая конфигурация
- ✅ Оптимизация для SSE (отключен buffering)
- ✅ Rate limiting (10 req/min для SSE)
- ✅ CORS для ChatGPT

### 5. Тестирование
- ✅ `scripts/test-chatgpt-mcp.sh` - Скрипт для тестирования

---

## 📋 Что Нужно Сделать Сейчас

### Шаг 1: Деплой Backend (5 минут)

```bash
# 1. Перейти в директорию backend
cd /home/vovkes/SecondLayer/mcp_backend

# 2. Обновить зависимости (если нужно)
npm install

# 3. Собрать проект
npm run build

# 4. Перезапустить backend
pm2 restart mcp-backend

# Или если backend еще не запущен:
pm2 start dist/http-server.js --name mcp-backend \
  --max-memory-restart 2G \
  --log-date-format "YYYY-MM-DD HH:mm:ss Z"

# 5. Сохранить PM2 конфигурацию
pm2 save

# 6. Проверить статус
pm2 status
pm2 logs mcp-backend --lines 20
```

**Ожидаемый вывод в логах:**
```
HTTP MCP Server started on http://0.0.0.0:3000
MCP SSE Server initialized
ChatGPT Web Integration:
  - MCP Server URL: https://mcp.legal.org.ua/sse
  - Discovery: https://mcp.legal.org.ua/mcp
```

### Шаг 2: Настройка Nginx (10 минут)

```bash
# 1. Скопировать конфигурацию nginx
sudo cp /home/vovkes/SecondLayer/mcp_backend/nginx-mcp-chatgpt.conf \
  /etc/nginx/sites-available/mcp.legal.org.ua

# 2. Создать символическую ссылку (если еще нет)
sudo ln -s /etc/nginx/sites-available/mcp.legal.org.ua \
  /etc/nginx/sites-enabled/

# 3. Проверить конфигурацию
sudo nginx -t

# 4. Перезагрузить nginx
sudo systemctl reload nginx

# 5. Проверить статус
sudo systemctl status nginx
```

### Шаг 3: Настройка DNS (если еще нет)

Убедитесь, что домен `mcp.legal.org.ua` указывает на ваш сервер:

```bash
# Проверить DNS
nslookup mcp.legal.org.ua

# Должно вернуть IP вашего сервера
```

Если DNS не настроен:
```bash
# Добавить A-запись в вашем DNS провайдере:
mcp.legal.org.ua    A    <ваш IP адрес>
```

### Шаг 4: Настройка SSL (если еще нет)

```bash
# Установить certbot (если еще нет)
sudo apt install certbot python3-certbot-nginx

# Получить сертификат
sudo certbot certonly --nginx -d mcp.legal.org.ua

# Сертификаты будут сохранены в:
# /etc/letsencrypt/live/mcp.legal.org.ua/fullchain.pem
# /etc/letsencrypt/live/mcp.legal.org.ua/privkey.pem
```

### Шаг 5: Тестирование (3 минуты)

```bash
# Запустить тестовый скрипт
cd /home/vovkes/SecondLayer/mcp_backend
chmod +x scripts/test-chatgpt-mcp.sh
./scripts/test-chatgpt-mcp.sh https://mcp.legal.org.ua
```

**Ожидаемый вывод:**
```
=== ChatGPT MCP Integration Test ===

Testing server: https://mcp.legal.org.ua

1. Testing health endpoint...
✓ Health check passed
  Response: {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

2. Testing MCP discovery endpoint...
✓ MCP discovery passed
  Protocol version: 2024-11-05
  Server name: SecondLayer Legal MCP Server
  Tools available: 41

3. Testing SSE initialize...
✓ SSE initialize passed
  Received server/initialized event

4. Testing tools/list via SSE...
✓ Tools list via SSE passed
  Tools in SSE response: 41

5. Testing tool execution (classify_intent)...
✓ Tool execution passed
  Successfully executed classify_intent

6. Testing HTTP API endpoint...
✓ HTTP API passed
  Tools via HTTP: 41

=== Test Summary ===

Server: https://mcp.legal.org.ua
Health: ok
MCP Protocol: 2024-11-05
Tools Available: 41

All tests completed! ✅
```

Если все тесты прошли ✅ - можно переходить к настройке ChatGPT!

---

## 🤖 Подключение в ChatGPT (5 минут)

### Шаг 1: Открыть ChatGPT

1. Перейти на [https://chat.openai.com](https://chat.openai.com)
2. Войти в аккаунт

### Шаг 2: Включить Developer Mode

1. Нажать на свой профиль (левый нижний угол)
2. Settings → Beta Features
3. Включить **"Developer Mode"** или **"Custom MCP Servers"**

### Шаг 3: Добавить MCP Server

1. В ChatGPT нажать **"New App"** (или найти кнопку для добавления MCP server)

2. Заполнить форму:

```
┌──────────────────────────────────────────────────┐
│ Icon: [+]                                        │
│ (опционально, можно пропустить)                  │
│                                                  │
│ Name:                                            │
│ SecondLayer Legal Research                       │
│                                                  │
│ Description:                                     │
│ Платформа для юридических исследований в         │
│ Украине с 40+ специализированными инструментами  │
│ для поиска судебных дел, анализа законодательства│
│ и правовых паттернов.                            │
│                                                  │
│ MCP Server URL:                                  │
│ https://mcp.legal.org.ua/sse                     │
│                                                  │
│ Authentication:                                  │
│ □ OAuth                                          │
│ (оставить пустым для теста)                      │
│                                                  │
│ OAuth Client ID (Optional):                      │
│ [оставить пустым]                                │
│                                                  │
│ OAuth Client Secret (Optional):                  │
│ [оставить пустым]                                │
│                                                  │
│ ☑ I understand and want to continue              │
└──────────────────────────────────────────────────┘

            [Create]  [Cancel]
```

3. Нажать **"Create"**

### Шаг 4: Проверить Подключение

ChatGPT должен показать:
```
✅ SecondLayer Legal Research
   Connected
   41 tools available
```

---

## 🧪 Тестирование в ChatGPT

### Тест 1: Простой запрос к законодательству

В ChatGPT напишите:
```
Покажи статью 354 ЦПК України
```

**Ожидаемый результат:**
ChatGPT вызовет `get_legislation_section` и покажет текст статьи 354 Цивільного процесуального кодексу.

### Тест 2: Поиск судебной практики

В ChatGPT напишите:
```
Знайди практику Верховного Суду про строки апеляційного оскарження
```

**Ожидаемый результат:**
ChatGPT вызовет `search_supreme_court_practice` и покажет релевантные постановы ВС.

### Тест 3: Комплексный анализ

В ChatGPT напишите:
```
Я пропустив строк апеляції, бо отримав повний текст рішення через 35 днів.
Що я можу зробити?
```

**Ожидаемый результат:**
ChatGPT вызовет несколько инструментов:
- `get_legislation_section` (для статьи о восстановлении сроков)
- `search_legal_precedents` (для похожих дел)
- `analyze_case_pattern` (для анализа успешных аргументов)
- `get_legal_advice` (для комплексного анализа)

И предоставит детальную консультацию со ссылками на источники.

---

## 📊 Мониторинг

### Просмотр Логов

```bash
# PM2 логи backend
pm2 logs mcp-backend

# Nginx логи
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Логи приложения
tail -f /home/vovkes/SecondLayer/mcp_backend/logs/combined.log
```

### Статистика Использования

```bash
# Подключиться к PostgreSQL
psql -U secondlayer secondlayer

# Запросить статистику
SELECT
  tool_name,
  COUNT(*) as executions,
  AVG(execution_time_ms) as avg_time_ms,
  SUM(total_cost_usd) as total_cost
FROM cost_tracking
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY tool_name
ORDER BY executions DESC
LIMIT 10;
```

### Проверка Здоровья

```bash
# Здоровье backend
curl https://mcp.legal.org.ua/health

# Количество инструментов
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'

# Список всех инструментов
curl https://mcp.legal.org.ua/mcp | jq '.tools[].name'
```

---

## 🐛 Troubleshooting

### Проблема: Backend не запускается

```bash
# Проверить логи
pm2 logs mcp-backend --lines 50

# Проверить порт
netstat -tulpn | grep 3000

# Убить процесс на порту 3000 (если занят)
sudo kill -9 $(lsof -t -i:3000)

# Перезапустить
pm2 restart mcp-backend
```

### Проблема: Nginx ошибки

```bash
# Проверить конфигурацию
sudo nginx -t

# Проверить логи ошибок
sudo tail -100 /var/log/nginx/error.log

# Перезапустить nginx
sudo systemctl restart nginx
```

### Проблема: SSL сертификат не работает

```bash
# Проверить сертификат
sudo certbot certificates

# Обновить сертификат
sudo certbot renew --force-renewal -d mcp.legal.org.ua

# Перезапустить nginx
sudo systemctl reload nginx
```

### Проблема: Инструменты не видны в ChatGPT

```bash
# Проверить количество инструментов
curl https://mcp.legal.org.ua/mcp | jq '.capabilities.tools.count'

# Должно быть 41
# Если 0, проверить логи backend:
pm2 logs mcp-backend | grep "MCP SSE Server initialized"
```

### Проблема: SSE connection timeout

```bash
# Проверить nginx конфигурацию для /sse
grep -A 20 "location /sse" /etc/nginx/sites-available/mcp.legal.org.ua

# Убедиться что есть:
# proxy_buffering off;
# proxy_set_header X-Accel-Buffering no;
# proxy_read_timeout 3600s;
```

---

## 📚 Дополнительные Ресурсы

- 📖 **Быстрый старт**: [CHATGPT_QUICKSTART.md](CHATGPT_QUICKSTART.md)
- 📖 **Полная документация**: [docs/CHATGPT_INTEGRATION.md](docs/CHATGPT_INTEGRATION.md)
- 📖 **Деплой**: [docs/DEPLOYMENT_CHATGPT.md](docs/DEPLOYMENT_CHATGPT.md)
- 📖 **Примеры**: [EXAMPLES_CHATGPT.md](EXAMPLES_CHATGPT.md)
- 📖 **Changelog**: [CHANGELOG_CHATGPT.md](CHANGELOG_CHATGPT.md)
- 📖 **Все инструменты**: [../lexconfig/mcp_tools.txt](../lexconfig/mcp_tools.txt)

---

## ✅ Checklist

Перед подключением к ChatGPT убедитесь:

- [ ] Backend запущен и отвечает на `/health`
- [ ] Nginx настроен и работает
- [ ] SSL сертификат валидный
- [ ] DNS указывает на правильный IP
- [ ] Тест `./scripts/test-chatgpt-mcp.sh` проходит успешно
- [ ] `/mcp` endpoint возвращает 41 инструмент
- [ ] `/sse` endpoint принимает подключения

Если все ✅ - можно подключать к ChatGPT!

---

## 🎉 Готово!

После успешного подключения вы сможете:

✨ Использовать 41 юридический инструмент прямо в ChatGPT
✨ Искать судебную практику на украинском языке
✨ Анализировать законодательство
✨ Получать комплексные юридические консультации
✨ Обрабатывать документы (PDF, DOCX)
✨ Проводить due diligence

**Удачи! 🚀**

---

## 📞 Поддержка

Если возникли проблемы:
1. Проверьте логи: `pm2 logs mcp-backend`
2. Запустите тест: `./scripts/test-chatgpt-mcp.sh`
3. Проверьте документацию в `docs/`
4. Создайте issue на GitHub с подробным описанием и логами
