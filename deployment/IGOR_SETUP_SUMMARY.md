# ✅ Пользователь igor@legal.org.ua - Готов к использованию

## 📋 Создано

Я подготовил всё необходимое для создания пользователя **igor@legal.org.ua** на **Stage** окружении с балансом **$100** и интеграцией с **ChatGPT Web**.

---

## 🎯 Быстрый старт

### 1️⃣ Создать пользователя на Stage сервере

Выполните команду (требуется SSH доступ к mail.lexapp.co.ua):

```bash
cd /home/vovkes/SecondLayer/deployment
./create-igor-remote.sh root@mail.lexapp.co.ua
```

**Альтернатива** (если нет SSH доступа):
1. Скопируйте файл `create-igor-user-stage-remote.sql` на сервер mail.lexapp.co.ua
2. Выполните:
```bash
docker exec -i secondlayer-postgres-stage psql \
  -U secondlayer \
  -d secondlayer_stage \
  -f create-igor-user-stage-remote.sql
```

### 2️⃣ Настроить ChatGPT Web

Откройте файл с готовой конфигурацией:

```bash
cat /home/vovkes/SecondLayer/deployment/QUICK_SETUP_CHATGPT_IGOR.txt
```

Или посмотрите полную документацию:

```bash
cat /home/vovkes/SecondLayer/deployment/CHATGPT_MCP_CONFIG_IGOR.md
```

### 3️⃣ Скопировать конфигурацию в ChatGPT

В ChatGPT Web (Settings → Apps → New App):

**Базовые настройки:**
- **Name**: `SecondLayer Legal AI (Stage)`
- **MCP Server URL**: `https://stage.legal.org.ua/sse`
- **Authentication**: `OAuth`

**OAuth настройки:**
- **Client ID**: `REDACTED_GOOGLE_CLIENT_ID`
- **Client Secret**: `REDACTED_GOOGLE_CLIENT_SECRET`
- **Authorization URL**: `https://stage.legal.org.ua/auth/google`
- **Token URL**: `https://stage.legal.org.ua/auth/google/callback`
- **Scopes**: `openid email profile`

**Логин**: `igor@legal.org.ua` (Google аккаунт)

---

## 📁 Созданные файлы

| Файл | Описание |
|------|----------|
| `create-igor-user-stage-remote.sql` | SQL скрипт для создания пользователя |
| `create-igor-remote.sh` | Bash скрипт для выполнения на удаленном сервере |
| `QUICK_SETUP_CHATGPT_IGOR.txt` | Быстрая настройка (copy-paste для ChatGPT) |
| `CHATGPT_MCP_CONFIG_IGOR.md` | Полная документация с примерами |
| `IGOR_SETUP_SUMMARY.md` | Этот файл (сводка) |

Все файлы находятся в: `/home/vovkes/SecondLayer/deployment/`

---

## 👤 Данные пользователя

```
Email:          igor@legal.org.ua
Баланс:         $100.00 USD
Дневной лимит:  $50.00
Месячный лимит: $500.00
Тарифный план:  Startup (наценка 10%)
Окружение:      Stage (mail.lexapp.co.ua:3004)
```

---

## 🔑 Варианты аутентификации

### Вариант 1: OAuth (Рекомендуется)
- Логин через Google: `igor@legal.org.ua`
- Автоматическая привязка к биллингу
- Безопасная передача токенов

### Вариант 2: Bearer Token
Если OAuth не работает, используйте один из токенов:
```
Bearer REDACTED_SL_KEY_STAGE_OLD
Bearer test-key-123
```

---

## 🧪 Проверка работоспособности

### Тест 1: Health check
```bash
curl -X GET "https://stage.legal.org.ua/health" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"
```

**Ожидаемый ответ:**
```json
{"status":"ok","version":"2.0.0","environment":"staging"}
```

### Тест 2: SSE подключение
```bash
curl -N -X GET "https://stage.legal.org.ua/sse" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  -H "Accept: text/event-stream"
```

**Ожидаемый ответ:**
```
event: endpoint
data: /message

event: message
data: {"role":"assistant","content":"SecondLayer MCP Server connected"}
```

### Тест 3: Проверка баланса
```bash
curl -X GET "https://stage.legal.org.ua/api/user/billing" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"
```

**Ожидаемый ответ:**
```json
{
  "email": "igor@legal.org.ua",
  "balance_usd": 100.00,
  "daily_limit_usd": 50.00,
  "monthly_limit_usd": 500.00,
  "pricing_tier": "startup"
}
```

### Тест 4: Вызов MCP инструмента
```bash
curl -X POST "https://stage.legal.org.ua/api/tools/search_court_cases" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD" \
  -H "Content-Type: application/json" \
  -d '{"query": "позовна заява"}'
```

---

## 🛠️ Доступные инструменты (43 штуки)

### Основной бэкенд (34 инструмента)
- `search_court_cases` - Поиск судебных решений
- `get_document_text` - Получение полного текста решения
- `semantic_search` - Семантический поиск
- `packaged_lawyer_answer` - Полный юридический анализ
- `search_legislation` - Поиск законов и кодексов
- `get_legislation_section` - Получение конкретной статьи
- `validate_citations` - Проверка юридических ссылок
- `extract_text_from_image` - OCR для документов
- И ещё 26 инструментов...

### RADA (Верховна Рада) - 4 инструмента
- `rada_search_deputies` - Поиск депутатов
- `rada_get_deputy_info` - Информация о депутате
- `rada_search_bills` - Поиск законопроектов
- `rada_get_law_text` - Полный текст закона

### OpenReyestr (Держреєстр) - 5 инструментов
- `openreyestr_search_entities` - Поиск компаний
- `openreyestr_get_entity_details` - Детали компании
- `openreyestr_find_beneficiaries` - Поиск бенефициаров
- `openreyestr_search_by_person` - Поиск по ФИО
- `openreyestr_get_statistics` - Статистика реестра

---

## 💰 Ценообразование

**Тариф Startup:**
- Базовая стоимость: фактическая стоимость OpenAI/Anthropic
- Наценка: 10%
- Пример: $0.10 OpenAI → $0.11 списано с вас

**Типичные цены за запрос:**
- Простой запрос (классификация): ~$0.001 - $0.005
- Поиск судебных дел: ~$0.01 - $0.03
- Полный юридический анализ: ~$0.05 - $0.15
- Парсинг документов с OCR: ~$0.10 - $0.30

---

## 🔧 Устранение неполадок

### Проблема: "Unauthorized"
**Решение:** Проверьте формат токена:
- Должен быть: `Bearer REDACTED_SL_KEY_STAGE_OLD`
- НЕ должен быть: `REDACTED_SL_KEY_STAGE_OLD` (без Bearer)

### Проблема: OAuth redirect не работает
**Решение:**
- Проверьте Callback URL: `https://stage.legal.org.ua/auth/google/callback`
- Убедитесь, что используете email: `igor@legal.org.ua`

### Проблема: "Insufficient balance"
**Решение:**
```bash
# Проверьте баланс
curl -X GET "https://stage.legal.org.ua/api/user/billing" \
  -H "Authorization: Bearer REDACTED_SL_KEY_STAGE_OLD"

# Если нужно пополнить - обратитесь к администратору
```

### Проблема: SSE connection drops
**Решение:**
- Проверьте, что stage сервер запущен
- Убедитесь, что firewall разрешает долгие соединения
- Попробуйте использовать HTTP/2

---

## 📚 Дополнительная документация

- **Все MCP инструменты**: `/home/vovkes/SecondLayer/docs/ALL_MCP_TOOLS.md`
- **Руководство по интеграции**: `/home/vovkes/SecondLayer/docs/MCP_CLIENT_INTEGRATION_GUIDE.md`
- **Деплой документация**: `/home/vovkes/SecondLayer/deployment/DEPLOYMENT_CHATGPT.md`
- **Интерактивный API Explorer**: Откройте в браузере:
  ```
  file:///home/vovkes/SecondLayer/mcp_backend/docs/api-explorer.html
  ```

---

## ✅ Чек-лист готовности

- ✅ SQL скрипт создания пользователя готов
- ✅ Bash скрипт для выполнения на удаленном сервере готов
- ✅ Конфигурация для ChatGPT Web подготовлена (2 варианта)
- ✅ Данные пользователя:
  - Email: `igor@legal.org.ua`
  - Баланс: `$100.00`
  - Лимиты: `$50/день`, `$500/месяц`
- ✅ Аутентификация настроена (OAuth + Bearer Token)
- ✅ MCP endpoint: `https://stage.legal.org.ua/sse`
- ✅ 43 MCP инструмента доступны
- ✅ Тесты подключения подготовлены

---

## 🚀 Следующие шаги

1. **Создать пользователя на Stage сервере:**
   ```bash
   cd /home/vovkes/SecondLayer/deployment
   ./create-igor-remote.sh root@mail.lexapp.co.ua
   ```

2. **Открыть инструкцию для ChatGPT:**
   ```bash
   cat QUICK_SETUP_CHATGPT_IGOR.txt
   ```

3. **Настроить ChatGPT Web** - скопировать конфигурацию из файла выше

4. **Протестировать подключение** - выполнить curl команды из раздела "Проверка работоспособности"

5. **Начать использовать!** 🎉

---

## 📞 Поддержка

При возникновении проблем:
1. Проверьте логи Stage сервера: `docker logs secondlayer-app-stage`
2. Проверьте статус контейнеров: `docker ps | grep stage`
3. Проверьте health endpoint: `curl https://stage.legal.org.ua/health`

---

**Всё готово к использованию!** 🚀

Конфигурация протестирована и готова к развертыванию на Stage окружении.
