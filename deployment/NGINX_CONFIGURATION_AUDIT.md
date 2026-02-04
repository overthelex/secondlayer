# Nginx Configuration Audit - Gate Server

**Дата проверки:** 2026-02-04
**Сервер:** gate.lexapp.co.ua

## Executive Summary

На сервере gate обнаружены **критические расхождения** между документацией и фактической конфигурацией:

1. ❌ **Stage окружение не работает** - контейнеры не запущены
2. ❌ **Конфликт портов** - stage frontend назначен порт 8092, который занят другим сервисом
3. ❌ **Архитектура не соответствует документации** - используется только системный nginx вместо двухуровневой системы
4. ⚠️ **stage.legal.org.ua проксирует на неправильный сервис** - указывает на legal-issues server, а не SecondLayer

## Текущая Архитектура

### 1. Nginx Конфигурация

**Факт:** Используется ТОЛЬКО системный nginx на хосте (без docker gateway)

**Вопреки документации:** В GATEWAY_SETUP.md описана двухуровневая архитектура:
- Системный nginx (SSL termination) → Gateway nginx (docker) → Окружения
- Gateway контейнер `legal-nginx-gateway` на порту 8080

**Реальность:**
- Gateway контейнер отсутствует
- Системный nginx напрямую проксирует на окружения

### 2. Конфигурации Nginx на Хосте

Расположение: `/etc/nginx/sites-enabled/`

| Файл | Статус | Описание |
|------|--------|----------|
| `legal.org.ua` | ✅ Работает | Production окружение |
| `dev.legal.org.ua` | ✅ Работает | Development окружение |
| `stage.legal.org.ua` | ❌ **НЕПРАВИЛЬНО** | Проксирует на legal-issues server |
| `mcp.legal.org.ua` | ✅ Работает | MCP эндпоинт для production |
| `stage.mcp.legal.org.ua` | ❌ Не работает | Проксирует на порт 3004 (не отвечает) |
| `api.legal.org.ua` | ⚠️ Не проверялся | - |
| `update.legal.org.ua` | ⚠️ Не проверялся | - |

## Детальный Анализ по Окружениям

### Production Environment ✅

**Домен:** `https://legal.org.ua`

**Nginx Config:** `/etc/nginx/sites-enabled/legal.org.ua`

**Маршрутизация:**
```
Backend:  /api/, /auth/, /health → http://127.0.0.1:3001
Frontend: / → http://127.0.0.1:8090
SSE:      /sse → http://127.0.0.1:3001/sse
```

**Docker Containers:**
- ✅ `secondlayer-app-prod` - Backend на порту 3001
- ✅ `lexwebapp-prod` - Frontend на порту 8090
- ✅ `secondlayer-postgres-prod` - PostgreSQL на порту 5432
- ✅ `secondlayer-redis-prod` - Redis на порту 6379
- ✅ `secondlayer-qdrant-prod` - Qdrant на портах 6333-6334

**Статус:** ✅ **Полностью работает**

---

### Development Environment ✅

**Домен:** `https://dev.legal.org.ua`

**Nginx Config:** `/etc/nginx/sites-enabled/dev.legal.org.ua`

**Маршрутизация:**
```
Backend:  /api/, /auth/, /health → http://127.0.0.1:3003
Frontend: / → http://127.0.0.1:8091
SSE:      /sse → http://127.0.0.1:3003/sse
```

**Docker Containers:**
- ✅ `secondlayer-app-dev` - Backend на порту 3003
- ✅ `lexwebapp-dev` - Frontend на порту 8091
- ✅ `secondlayer-postgres-dev` - PostgreSQL на порту 5433
- ✅ `secondlayer-redis-dev` - Redis на порту 6380
- ✅ `secondlayer-qdrant-dev` - Qdrant на портах 6335-6336

**Статус:** ✅ **Полностью работает**

---

### Staging Environment ❌ КРИТИЧЕСКИЕ ПРОБЛЕМЫ

**Домен:** `https://stage.legal.org.ua`

**Nginx Config:** `/etc/nginx/sites-enabled/stage.legal.org.ua`

**Маршрутизация (НЕПРАВИЛЬНО):**
```
Backend:  /api/, /auth/, /health → http://127.0.0.1:3002 ❌ НЕПРАВИЛЬНЫЙ СЕРВИС
Frontend: / → http://127.0.0.1:8093 ❌ ПОРТ НЕ СЛУШАЕТ
```

**Проблема #1: Backend на порту 3002**
- ❌ Nginx проксирует на порт 3002
- ⚠️ На порту 3002 работает **legal-issues server** (systemd service), а не SecondLayer!
- Процесс: `/usr/bin/node server.js` (PID 562130, пользователь www-data)
- Рабочая директория: `/opt/legal-issues-server`
- Systemd service: `legal-issues.service`

**Проблема #2: Docker Containers НЕ ЗАПУЩЕНЫ**
- ❌ `secondlayer-app-stage` - НЕ ЗАПУЩЕН
- ❌ `lexwebapp-stage` - НЕ ЗАПУЩЕН
- ❌ `secondlayer-postgres-stage` - НЕ ЗАПУЩЕН
- ❌ `secondlayer-redis-stage` - НЕ ЗАПУЩЕН
- ❌ `secondlayer-qdrant-stage` - НЕ ЗАПУЩЕН

**Проблема #3: Конфликт Портов**
- Docker-compose.stage.yml настроен на:
  - Backend: `3002:3002` ✅ (совпадает с nginx)
  - Frontend: `8092:80` ❌ **КОНФЛИКТ!**
- Nginx ожидает frontend на порту 8093
- Docker-compose назначает порт 8092
- Порт 8092 уже занят контейнером `legal-policies`

**Проверка:**
```bash
$ curl http://localhost:3002/health
{"status":"ok","timestamp":"2026-02-04T12:08:37.027Z"}  # legal-issues server, НЕ SecondLayer!

$ curl http://localhost:8093
Port 8093 (stage frontend) not responding
```

**Статус:** ❌ **НЕ РАБОТАЕТ - Требует немедленного исправления**

---

### Staging MCP Environment ❌

**Домен:** `https://stage.mcp.legal.org.ua`

**Nginx Config:** `/etc/nginx/sites-enabled/stage.mcp.legal.org.ua`

**Маршрутизация:**
```
Backend: / → http://localhost:3004 ❌ ПОРТ НЕ ОТВЕЧАЕТ
SSE:     /sse → http://localhost:3004/sse ❌ ПОРТ НЕ ОТВЕЧАЕТ
```

**Проверка:**
```bash
$ curl http://localhost:3004/health
Port 3004 not responding
```

**Статус:** ❌ **НЕ РАБОТАЕТ - Порт 3004 не слушает**

## Расхождение с Документацией

### GATEWAY_SETUP.md vs Реальность

| Параметр | Документация | Реальность | Статус |
|----------|--------------|------------|--------|
| **Архитектура** | Nginx host → Gateway docker → Окружения | Nginx host → Окружения напрямую | ❌ Не соответствует |
| **Gateway контейнер** | `legal-nginx-gateway` на порту 8080 | Отсутствует | ❌ Не существует |
| **Stage Backend Port** | 3002 (но также упоминается 3004) | 3002 (но это legal-issues!) | ❌ Путаница |
| **Stage Frontend Port** | 8093 (из nginx) | 8092 (из docker-compose) | ❌ Конфликт |
| **Prod Backend Port** | 3001 | 3001 | ✅ Совпадает |
| **Dev Backend Port** | 3003 | 3003 | ✅ Совпадает |

### SETUP_INSTRUCTIONS.md

Документ упоминает порт 3004 для stage backend:
```
Staging Backend Port: 3004 (not 3002)
- docker-compose.stage.yml maps internal port 3000 → host port 3004
```

**Реальность:**
- docker-compose.stage.yml использует порт 3002
- Nginx использует порт 3002
- Порт 3004 вообще не используется

## Дополнительные Сервисы

На сервере работают дополнительные сервисы, не описанные в основной документации:

| Контейнер | Порты | Назначение |
|-----------|-------|------------|
| `legal-policies` | 8092:80 | ⚠️ Занимает порт, нужный для stage frontend |
| `openreyestr-app-dev` | 3005:3005 | OpenReyestr MCP server |
| `document-service-gate` | 3006:3002 | Document parsing service |

## Порты на Сервере

### Backend Порты (30xx)
```
3001 ✅ Production backend (docker: secondlayer-app-prod)
3002 ⚠️ Legal-issues server (systemd: legal-issues.service) - НЕ SecondLayer!
3003 ✅ Development backend (docker: secondlayer-app-dev)
3004 ❌ Не используется (но nginx ожидает stage MCP здесь)
3005 ✅ OpenReyestr dev (docker: openreyestr-app-dev)
3006 ✅ Document service (docker: document-service-gate)
```

### Frontend Порты (80xx)
```
8090 ✅ Production frontend (docker: lexwebapp-prod)
8091 ✅ Development frontend (docker: lexwebapp-dev)
8092 ✅ Legal policies (docker: legal-policies) - КОНФЛИКТ с stage!
8093 ❌ Не используется (но nginx ожидает stage frontend здесь)
```

### Database Порты (54xx)
```
5432 ✅ Production PostgreSQL (docker: secondlayer-postgres-prod)
5433 ✅ Development PostgreSQL (docker: secondlayer-postgres-dev)
5434 ⚠️ Staging PostgreSQL (должен быть, но контейнер не запущен)
```

### Cache Порты (63xx)
```
6379 ✅ Production Redis (docker: secondlayer-redis-prod)
6380 ✅ Development Redis (docker: secondlayer-redis-dev)
6381 ⚠️ Staging Redis (должен быть, но контейнер не запущен)
```

### Vector DB Порты (633x-634x)
```
6333-6334 ✅ Production Qdrant (docker: secondlayer-qdrant-prod)
6335-6336 ✅ Development Qdrant (docker: secondlayer-qdrant-dev)
6337-6338 ⚠️ Staging Qdrant (должен быть, но контейнер не запущен)
```

## Nginx Warnings

При проверке nginx выявлены предупреждения:

```
[warn] the "listen ... http2" directive is deprecated, use the "http2" directive instead
  - dev.legal.org.ua:40-41
  - legal.org.ua:33-34

[warn] protocol options redefined for 0.0.0.0:443
  - mcp.legal.org.ua:26-27
```

**Рекомендация:** Обновить синтаксис на современный (http2 on;)

## Рекомендации по Исправлению

### Приоритет 1 - КРИТИЧНО

#### 1.1. Исправить Stage Backend
**Проблема:** stage.legal.org.ua проксирует на legal-issues server вместо SecondLayer

**Решения (выбрать одно):**

**Вариант А - Запустить Stage окружение в Docker (РЕКОМЕНДУЕТСЯ)**
```bash
# На сервере gate
cd /home/vovkes/SecondLayer/deployment

# Запустить stage окружение
docker compose -f docker-compose.stage.yml --env-file .env.stage up -d

# Проверить статус
docker compose -f docker-compose.stage.yml ps
```

**Вариант Б - Переназначить stage.legal.org.ua на другой порт**
Если legal-issues server должен оставаться на stage.legal.org.ua:
- Запустить SecondLayer stage на другом порту (например, 3007)
- Создать новый поддомен для SecondLayer stage

#### 1.2. Исправить Конфликт Портов Frontend
**Проблема:** docker-compose.stage.yml использует порт 8092, nginx ожидает 8093

**Решение 1 - Изменить docker-compose.stage.yml (РЕКОМЕНДУЕТСЯ)**
```yaml
lexwebapp-stage:
  ports:
    - "8093:80"  # Изменить с 8092 на 8093
```

**Решение 2 - Изменить nginx конфигурацию**
```nginx
upstream stage_frontend {
    server 127.0.0.1:8092;  # Изменить с 8093 на 8092
}
```

**Или - Переместить legal-policies на другой порт**
```bash
# Освободить порт 8092 для stage
docker stop legal-policies
docker rm legal-policies
# Перезапустить legal-policies на другом порту (например, 8094)
```

#### 1.3. Запустить Stage MCP на порту 3004
**Проблема:** stage.mcp.legal.org.ua ожидает backend на порту 3004, но там ничего нет

**Решение:**
- Если нужен отдельный MCP эндпоинт для stage, запустить контейнер на 3004
- Или удалить конфигурацию stage.mcp.legal.org.ua и использовать stage.legal.org.ua/sse

### Приоритет 2 - ВАЖНО

#### 2.1. Обновить Документацию
Файлы требующие обновления:
- `deployment/GATEWAY_SETUP.md` - убрать упоминание gateway docker
- `deployment/SETUP_INSTRUCTIONS.md` - исправить порты для stage
- `CLAUDE.md` - добавить описание фактической архитектуры

#### 2.2. Исправить Синтаксис Nginx
Обновить deprecated директивы:
```nginx
# Было
listen 443 ssl http2;

# Должно быть
listen 443 ssl;
http2 on;
```

#### 2.3. Создать Gateway Контейнер (Опционально)
Если нужна двухуровневая архитектура из документации:
1. Создать nginx gateway контейнер
2. Переключить системный nginx на проксирование через gateway:8080
3. Обновить конфигурацию как описано в GATEWAY_SETUP.md

### Приоритет 3 - УЛУЧШЕНИЯ

#### 3.1. Стандартизировать Порты
Привести в соответствие с документацией:
```
Production: 3001 (backend), 8090 (frontend)
Staging:    3002 (backend), 8092 (frontend)  # Или 3004/8093
Development:3003 (backend), 8091 (frontend)
```

#### 3.2. Мониторинг Здоровья
Добавить мониторинг всех health endpoints:
```bash
*/5 * * * * curl -sf https://legal.org.ua/health || alert
*/5 * * * * curl -sf https://dev.legal.org.ua/health || alert
*/5 * * * * curl -sf https://stage.legal.org.ua/health || alert
```

## План Действий

### Шаг 1: Диагностика (5 минут)
```bash
# Определить назначение legal-issues server на порту 3002
systemctl status legal-issues
cat /etc/systemd/system/legal-issues.service

# Проверить, можно ли его переместить или остановить
```

### Шаг 2: Решение (выбрать стратегию)

**Стратегия А: Запустить Stage окружение на новых портах**
- Stage backend: 3004
- Stage frontend: 8093
- Обновить docker-compose.stage.yml
- Обновить nginx конфиги
- Запустить контейнеры

**Стратегия Б: Переназначить stage.legal.org.ua**
- Создать stage-app.legal.org.ua для SecondLayer
- Оставить stage.legal.org.ua для legal-issues
- Обновить DNS и SSL сертификаты

### Шаг 3: Тестирование
```bash
# После применения исправлений
curl https://stage.legal.org.ua/health
curl https://stage.legal.org.ua/api/...
curl https://stage.mcp.legal.org.ua/health
```

### Шаг 4: Обновление Документации
- Исправить все упоминания stage портов
- Документировать фактическую архитектуру nginx
- Обновить GATEWAY_SETUP.md

## Контрольный Список

- [ ] Определить назначение legal-issues server
- [ ] Запустить stage docker containers
- [ ] Исправить конфликт портов 8092/8093
- [ ] Настроить stage.mcp.legal.org.ua на порт 3004
- [ ] Обновить docker-compose.stage.yml
- [ ] Обновить nginx конфигурации
- [ ] Протестировать все endpoints
- [ ] Обновить документацию
- [ ] Исправить deprecated nginx директивы
- [ ] Настроить мониторинг

## Заключение

Текущая конфигурация nginx на сервере gate **частично работоспособна**:
- ✅ Production окружение работает корректно
- ✅ Development окружение работает корректно
- ❌ **Stage окружение не работает** - требует немедленного вмешательства
- ❌ **Stage MCP не работает** - порт не слушает

**Основная причина:** Stage docker контейнеры не запущены, а nginx проксирует на другой сервис.

**Рекомендация:** Запустить stage окружение в docker с правильными портами или переназначить поддомены.

---

**Проверено:** 2026-02-04
**Проверил:** Claude Code
**Следующая проверка:** После внесения исправлений
