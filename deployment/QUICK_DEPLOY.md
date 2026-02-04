# Quick Deploy to Mail Server

## TL;DR

```bash
cd deployment
./deploy-stage-mcp-to-mail.sh
```

Этот скрипт автоматически:
1. Проверит подключение к mail server (178.162.234.145)
2. Проверит, запущен ли staging backend на порту 3004
3. Скопирует nginx конфигурацию на mail server
4. Установит конфигурацию в `/etc/nginx/sites-available/`
5. Создаст symlink в `sites-enabled/`
6. Получит SSL сертификат через certbot (если нужно)
7. Перезагрузит nginx
8. Протестирует подключение

## Что уже готово

✅ DNS: `stage.mcp.legal.org.ua` → `178.162.234.145` (mail.lexapp.co.ua)
✅ Nginx конфигурация: `deployment/nginx-stage-mcp.conf`
✅ Тестовые скрипты: `test-stage-local.sh`, `test-stage-mcp-connection.sh`
✅ Deploy скрипт: `deploy-stage-mcp-to-mail.sh`

## Ручная установка (если скрипт не работает)

### 1. Проверить staging backend на mail сервере

```bash
ssh root@mail.lexapp.co.ua

# Проверить, запущен ли staging
docker ps | grep stage
netstat -tlnp | grep 3004

# Если не запущен, запустить
cd /path/to/deployment
docker compose -f docker-compose.stage.yml --env-file .env.stage up -d

# Проверить логи
docker logs secondlayer-app-stage
```

### 2. Установить nginx конфигурацию

```bash
# На локальной машине
scp deployment/nginx-stage-mcp.conf root@mail.lexapp.co.ua:/tmp/

# На mail сервере
ssh root@mail.lexapp.co.ua
sudo mv /tmp/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua
sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/
sudo nginx -t
```

### 3. Получить SSL сертификат

```bash
# На mail сервере
sudo certbot --nginx -d stage.mcp.legal.org.ua

# Если нужно обновить сертификат
sudo certbot renew --nginx
```

### 4. Перезагрузить nginx

```bash
# На mail сервере
sudo systemctl reload nginx
```

### 5. Протестировать

```bash
# На локальной машине
curl https://stage.mcp.legal.org.ua/health
curl -H "Authorization: Bearer test-key-123" https://stage.mcp.legal.org.ua/mcp

# Полный тест
./deployment/test-stage-mcp-connection.sh
```

## После установки

### URL для подключения
```
https://stage.mcp.legal.org.ua/sse
```

### API Token
```
Authorization: Bearer test-key-123
```

### Claude Desktop конфигурация

Добавить в `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondlayer-stage": {
      "url": "https://stage.mcp.legal.org.ua/sse",
      "transport": {
        "type": "sse"
      },
      "headers": {
        "Authorization": "Bearer test-key-123"
      }
    }
  }
}
```

После изменения конфигурации перезапустить Claude Desktop.

## Troubleshooting

### 404 Not Found

**Причина**: Nginx не видит конфигурацию или staging backend не запущен

**Решение**:
```bash
ssh root@mail.lexapp.co.ua

# Проверить nginx конфигурацию
sudo nginx -t
sudo ls -la /etc/nginx/sites-enabled/ | grep stage

# Проверить staging backend
docker ps | grep stage
curl localhost:3004/health
```

### 502 Bad Gateway

**Причина**: Staging backend не отвечает на порту 3004

**Решение**:
```bash
ssh root@mail.lexapp.co.ua

# Проверить backend
docker logs secondlayer-app-stage
curl localhost:3004/health

# Перезапустить backend
docker restart secondlayer-app-stage
```

### SSL Certificate Error

**Причина**: Сертификат не получен или expired

**Решение**:
```bash
ssh root@mail.lexapp.co.ua

# Проверить сертификат
sudo certbot certificates

# Получить новый
sudo certbot --nginx -d stage.mcp.legal.org.ua

# Обновить
sudo certbot renew
```

### Connection Timeout

**Причина**: Firewall блокирует порты 80/443

**Решение**:
```bash
ssh root@mail.lexapp.co.ua

# Проверить firewall
sudo ufw status
sudo iptables -L -n

# Открыть порты если нужно
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## Мониторинг

### Логи nginx
```bash
ssh root@mail.lexapp.co.ua
sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-access.log
sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-error.log
```

### Логи backend
```bash
ssh root@mail.lexapp.co.ua
docker logs -f secondlayer-app-stage
```

### Проверка статуса
```bash
# Health check
curl https://stage.mcp.legal.org.ua/health

# MCP discovery
curl -H "Authorization: Bearer test-key-123" \
     https://stage.mcp.legal.org.ua/mcp
```

## Следующие шаги

1. ✅ Deploy на mail server
2. ✅ Протестировать с curl
3. ✅ Настроить Claude Desktop
4. 🔄 Протестировать через Claude Desktop
5. 📊 Настроить мониторинг (опционально)
