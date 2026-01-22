# Docker Remote - Быстрый старт

## ✅ Настройка завершена!

Теперь вы можете управлять Docker контейнерами на gate.lexapp.co.ua прямо с вашего ноутбука.

## Переключение контекстов

```bash
# Показать все контексты
docker context ls

# Переключиться на gate server (удаленный Docker)
docker context use gate-server

# Вернуться к локальному Docker
docker context use desktop-linux
```

## Примеры использования

### 1. Посмотреть контейнеры на gate server

```bash
docker context use gate-server
docker ps
```

Вывод:
```
CONTAINER ID   IMAGE                                  STATUS
d34a7aa7081f   secondlayer-console-payment-frontend   Up (healthy)
046806dde29e   secondlayer-console-payment-server     Up (healthy)
d3c013456440   postgres:16-alpine                     Up (healthy)
```

### 2. Смотреть логи в реальном времени

```bash
docker context use gate-server
docker logs -f secondlayer-payment-server
```

### 3. Статистика ресурсов

```bash
docker context use gate-server
docker stats
```

### 4. Перезапустить контейнер

```bash
docker context use gate-server
docker restart secondlayer-payment-frontend
```

### 5. Вернуться к локальному Docker

```bash
docker context use desktop-linux
docker ps  # Теперь показывает локальные контейнеры
```

## Полезные алиасы

Добавьте в `~/.zshrc`:

```bash
# Docker shortcuts
alias dgctx='docker context use gate-server'
alias dlctx='docker context use desktop-linux'
alias dgps='docker context use gate-server && docker ps'
alias sllogs='docker context use gate-server && docker logs -f secondlayer-payment-server'
```

После добавления:
```bash
source ~/.zshrc
```

Использование:
```bash
dgps      # docker ps на gate server
sllogs    # логи SecondLayer
dlctx     # вернуться к локальному Docker
```

## Docker Compose

Для работы с Docker Compose используйте SSH:

```bash
ssh vovkes@gate.lexapp.co.ua \
  "cd /opt/secondlayer-console && docker compose -f docker-compose.gate-server.yml ps"
```

## Текущий контекст

Звездочка (*) показывает активный контекст:

```bash
$ docker context ls
NAME              DOCKER ENDPOINT
default           unix:///var/run/docker.sock
desktop-linux *   unix:///Users/vovkes/.docker/run/docker.sock   ← АКТИВНЫЙ
gate-server       ssh://vovkes@gate.lexapp.co.ua
```

## Полная документация

См. [DOCKER_REMOTE_GUIDE.md](./DOCKER_REMOTE_GUIDE.md) для расширенного руководства.
