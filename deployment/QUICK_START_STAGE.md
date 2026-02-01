# Quick Start: Stage Environment

## Быстрый деплой на mail.legal.org.ua

```bash
cd deployment

# 1. Проверка (опционально)
./test-stage-deployment.sh

# 2. Сборка образов
./manage-gateway.sh build

# 3. Сохранить образы
docker save secondlayer-app:latest | gzip > /tmp/secondlayer-app.tar.gz
docker save lexwebapp-lexwebapp:latest | gzip > /tmp/lexwebapp.tar.gz

# 4. Скопировать на mail сервер
scp docker-compose.stage.yml .env.stage mail.legal.org.ua:~/secondlayer-stage/
scp /tmp/secondlayer-app.tar.gz mail.legal.org.ua:/tmp/
scp /tmp/lexwebapp.tar.gz mail.legal.org.ua:/tmp/

# 5. SSH на mail и загрузить образы
ssh mail.legal.org.ua << 'EOF'
docker load < /tmp/secondlayer-app.tar.gz
docker load < /tmp/lexwebapp.tar.gz
cd ~/secondlayer-stage

# Запустить деплой
docker compose -f docker-compose.stage.yml down
docker compose -f docker-compose.stage.yml up -d postgres-stage redis-stage qdrant-stage
sleep 15
docker compose -f docker-compose.stage.yml up migrate-stage
docker compose -f docker-compose.stage.yml up -d app-stage lexwebapp-stage
docker compose -f docker-compose.stage.yml ps
EOF
```

## Проверка работы миграций

```bash
# Посмотреть логи миграции
ssh mail.legal.org.ua "docker logs secondlayer-migrate-stage"

# Ожидаемый вывод:
# ✅ Migration 001_initial_schema.sql completed successfully
# ✅ Migration 002_add_html_field.sql completed successfully
# ...
# ✅ All migrations completed successfully
```

## Проверка работы приложения

```bash
# Health check
curl https://stage.legal.org.ua/health

# Ожидаемый результат:
# {"status":"ok","service":"secondlayer-mcp-http","version":"1.0.0"}

# Проверить таблицы
ssh mail.legal.org.ua "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c '\dt'"
```

## Структура контейнеров

```
secondlayer-postgres-stage   Up (healthy)      0.0.0.0:5434->5432/tcp
secondlayer-redis-stage      Up (healthy)      0.0.0.0:6381->6379/tcp
secondlayer-qdrant-stage     Up                0.0.0.0:6337-6338->6333-6334/tcp
secondlayer-migrate-stage    Exited (0)        # Должен завершиться успешно
secondlayer-app-stage        Up (healthy)      0.0.0.0:3004->3000/tcp
lexwebapp-stage              Up (healthy)      0.0.0.0:8093->80/tcp
```

## Быстрые команды

```bash
# Просмотр логов
ssh mail.legal.org.ua "docker logs -f secondlayer-app-stage"

# Проверка здоровья
ssh mail.legal.org.ua "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep stage"

# Перезапуск app
ssh mail.legal.org.ua "cd ~/secondlayer-stage && docker compose -f docker-compose.stage.yml restart app-stage"

# Проверка БД
ssh mail.legal.org.ua "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c 'SELECT COUNT(*) FROM users;'"

# Проверка миграций
ssh mail.legal.org.ua "docker logs secondlayer-migrate-stage | grep '✅'"
```

## Troubleshooting

### Миграции failed
```bash
ssh mail.legal.org.ua "docker logs secondlayer-migrate-stage"
ssh mail.legal.org.ua "docker exec secondlayer-postgres-stage psql -U secondlayer -d secondlayer_stage -c 'SELECT 1'"
```

### App не стартует
```bash
ssh mail.legal.org.ua "docker logs secondlayer-app-stage | tail -50"
ssh mail.legal.org.ua "cd ~/secondlayer-stage && docker compose -f docker-compose.stage.yml ps"
```

### Пересоздать окружение
```bash
ssh mail.legal.org.ua << 'EOF'
cd ~/secondlayer-stage
docker compose -f docker-compose.stage.yml down -v
docker compose -f docker-compose.stage.yml up -d postgres-stage redis-stage qdrant-stage
sleep 15
docker compose -f docker-compose.stage.yml up migrate-stage
docker compose -f docker-compose.stage.yml up -d app-stage lexwebapp-stage
EOF
```

## Endpoints

- **URL**: https://stage.legal.org.ua
- **API**: https://stage.legal.org.ua/api/
- **Health**: https://stage.legal.org.ua/health
- **Auth**: https://stage.legal.org.ua/auth/google
- **Frontend**: https://stage.legal.org.ua/

## Полная документация

См. [STAGE_DEPLOYMENT.md](./STAGE_DEPLOYMENT.md) для подробностей.
