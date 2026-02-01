# Quick Start: Production Environment

## ⚠️ ВАЖНО: Предварительная подготовка

**Перед деплоем в production обязательно:**

1. **Замените все placeholder значения в `.env.prod`**
2. **Создайте резервную копию БД**
3. **Протестируйте в stage окружении**

## Быстрый деплой на gate.legal.org.ua

```bash
cd deployment

# 1. Проверка конфигурации
./test-prod-deployment.sh

# 2. Резервная копия БД (КРИТИЧНО!)
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db > /backup/db_backup_$(date +%Y%m%d_%H%M%S).sql"

# 3. Сборка образов
./manage-gateway.sh build

# 4. Деплой на gate сервер
./manage-gateway.sh deploy prod

# ИЛИ вручную:
scp docker-compose.prod.yml .env.prod gate.legal.org.ua:~/secondlayer/

ssh gate.legal.org.ua << 'EOF'
cd ~/secondlayer

# Остановить app (НЕ БД!)
docker compose -f docker-compose.prod.yml stop app-prod lexwebapp-prod

# Запустить инфраструктуру
docker compose -f docker-compose.prod.yml up -d postgres-prod redis-prod qdrant-prod
sleep 15

# Запустить миграции
docker compose -f docker-compose.prod.yml up migrate-prod

# Запустить приложение
docker compose -f docker-compose.prod.yml up -d app-prod lexwebapp-prod
docker compose -f docker-compose.prod.yml ps
EOF
```

## Проверка работы миграций

```bash
# Посмотреть логи миграции
ssh gate.legal.org.ua "docker logs secondlayer-migrate-prod"

# Ожидаемый вывод:
# ✅ Migration 001_initial_schema.sql completed successfully
# ✅ Migration 002_add_html_field.sql completed successfully
# ...
# ✅ All migrations completed successfully
```

## Проверка работы приложения

```bash
# Health check (main domain)
curl https://legal.org.ua/health

# Health check (MCP SSE endpoint)
curl https://mcp.legal.org.ua/sse/health

# Ожидаемый результат:
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

# Проверить таблицы
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c '\\dt'"
```

## Структура контейнеров

```
secondlayer-postgres-prod   Up (healthy)      0.0.0.0:5432->5432/tcp
secondlayer-redis-prod      Up (healthy)      0.0.0.0:6379->6379/tcp
secondlayer-qdrant-prod     Up                0.0.0.0:6333-6334->6333-6334/tcp
secondlayer-migrate-prod    Exited (0)        # Должен завершиться успешно
secondlayer-app-prod        Up (healthy)      0.0.0.0:3001->3000/tcp
lexwebapp-prod              Up (healthy)      0.0.0.0:8090->80/tcp
```

## Быстрые команды

```bash
# Просмотр логов
ssh gate.legal.org.ua "docker logs -f secondlayer-app-prod"

# Проверка здоровья
ssh gate.legal.org.ua "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep prod"

# Перезапуск app
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml restart app-prod"

# Проверка БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c 'SELECT COUNT(*) FROM users;'"

# Проверка миграций
ssh gate.legal.org.ua "docker logs secondlayer-migrate-prod | grep '✅'"

# Резервная копия БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db | gzip > /backup/secondlayer_$(date +%Y%m%d_%H%M).sql.gz"
```

## Мониторинг

```bash
# Статистика ресурсов
ssh gate.legal.org.ua "docker stats --no-stream | grep prod"

# Проверка на ошибки за последние 24 часа
ssh gate.legal.org.ua "docker logs --since 24h secondlayer-app-prod | grep ERROR"

# Размер БД
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c 'SELECT pg_size_pretty(pg_database_size(current_database()));'"

# Проверка SSL сертификатов
ssh gate.legal.org.ua "sudo certbot certificates"
```

## Troubleshooting

### Миграции failed
```bash
ssh gate.legal.org.ua "docker logs secondlayer-migrate-prod"
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db -c 'SELECT 1'"
```

### App не стартует
```bash
ssh gate.legal.org.ua "docker logs secondlayer-app-prod | tail -50"
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml ps"
```

### Платежи не работают
```bash
# Проверить, что используются live keys
ssh gate.legal.org.ua "docker exec secondlayer-app-prod env | grep STRIPE_SECRET_KEY"
# Должно начинаться с: sk_live_

# Проверить MOCK_PAYMENTS
ssh gate.legal.org.ua "docker exec secondlayer-app-prod env | grep MOCK_PAYMENTS"
# Должно быть: false
```

### Откат к предыдущей версии
```bash
# Остановить приложение
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml stop app-prod"

# Восстановить БД из бэкапа
ssh gate.legal.org.ua "docker exec secondlayer-postgres-prod psql -U secondlayer -d secondlayer_db < /backup/db_backup_YYYYMMDD_HHMMSS.sql"

# Запустить предыдущую версию
ssh gate.legal.org.ua "cd ~/secondlayer && docker compose -f docker-compose.prod.yml up -d app-prod"
```

### HTTPS проблемы
```bash
# Проверить nginx
ssh gate.legal.org.ua "sudo nginx -t"
ssh gate.legal.org.ua "sudo systemctl reload nginx"

# Обновить SSL сертификаты
ssh gate.legal.org.ua "sudo certbot renew"
```

## Endpoints

- **URL**: https://legal.org.ua
- **MCP SSE**: https://mcp.legal.org.ua/sse
- **API**: https://legal.org.ua/api/
- **Health**: https://legal.org.ua/health
- **Auth**: https://legal.org.ua/auth/google
- **Frontend**: https://legal.org.ua/

## Чеклист безопасности

- [ ] ✅ Заполнены все placeholder значения в .env.prod
- [ ] ✅ Используются Stripe live keys (sk_live_*)
- [ ] ✅ Используются production Fondy credentials
- [ ] ✅ JWT_SECRET минимум 64 символа
- [ ] ✅ Сильный POSTGRES_PASSWORD
- [ ] ✅ MOCK_PAYMENTS=false
- [ ] ✅ Создана резервная копия БД
- [ ] ✅ Протестировано на stage
- [ ] ✅ SSL сертификаты действительны
- [ ] ✅ Firewall правила настроены
- [ ] ✅ Мониторинг настроен

## Автоматические резервные копии

Настройте cron на gate сервере:

```bash
ssh gate.legal.org.ua "crontab -e"

# Добавьте (бэкап каждые 6 часов):
0 */6 * * * docker exec secondlayer-postgres-prod pg_dump -U secondlayer secondlayer_db | gzip > /backup/secondlayer_$(date +\%Y\%m\%d_\%H\%M).sql.gz

# Очистка старых бэкапов (старше 7 дней):
0 2 * * * find /backup/ -name "secondlayer_*.sql.gz" -mtime +7 -delete
```

## Полная документация

См. [PROD_DEPLOYMENT.md](./PROD_DEPLOYMENT.md) для подробностей.
