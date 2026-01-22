# Управление Docker на Gate Server с локальной машины

Docker Context настроен! Теперь вы можете управлять Docker контейнерами на gate.lexapp.co.ua прямо с вашего ноутбука.

## Быстрый старт

### Переключение между контекстами

```bash
# Список всех контекстов
docker context ls

# Переключиться на gate server
docker context use gate-server

# Вернуться на локальный Docker
docker context use desktop-linux
```

### Основные команды

Все стандартные Docker команды работают через SSH:

```bash
# Переключитесь на gate-server контекст
docker context use gate-server

# Список контейнеров
docker ps

# Список всех контейнеров (включая остановленные)
docker ps -a

# Логи контейнера
docker logs secondlayer-payment-frontend
docker logs -f secondlayer-payment-server  # Follow mode

# Статистика использования ресурсов
docker stats

# Список образов
docker images

# Информация о контейнере
docker inspect secondlayer-payment-frontend

# Выполнить команду в контейнере
docker exec -it secondlayer-payment-server sh

# Остановить контейнер
docker stop secondlayer-payment-frontend

# Запустить контейнер
docker start secondlayer-payment-frontend

# Перезапустить контейнер
docker restart secondlayer-payment-frontend
```

## Docker Compose через SSH

Docker Compose нужно запускать через SSH, так как compose файлы находятся на удаленном сервере:

```bash
# Вариант 1: SSH + docker compose
ssh vovkes@gate.lexapp.co.ua "cd /opt/secondlayer-console && docker compose -f docker-compose.gate-server.yml ps"

# Вариант 2: Скопировать compose файл локально
scp vovkes@gate.lexapp.co.ua:/opt/secondlayer-console/docker-compose.gate-server.yml .
# Затем можно использовать с правильным контекстом
docker context use gate-server
docker compose -f docker-compose.gate-server.yml ps
```

## Полезные команды для SecondLayer Console

```bash
# Переключитесь на gate-server
docker context use gate-server

# Проверить статус всех контейнеров
docker ps --filter "name=secondlayer"

# Логи frontend (nginx + static files)
docker logs -f secondlayer-payment-frontend

# Логи backend (Node.js API)
docker logs -f secondlayer-payment-server

# Логи базы данных
docker logs -f secondlayer-payments-db

# Статистика ресурсов для SecondLayer контейнеров
docker stats secondlayer-payment-frontend secondlayer-payment-server secondlayer-payments-db

# Зайти внутрь контейнера
docker exec -it secondlayer-payment-server sh

# Проверить health status
docker ps --format "table {{.Names}}\t{{.Status}}"

# Перезапустить все SecondLayer контейнеры
docker restart secondlayer-payment-frontend secondlayer-payment-server secondlayer-payments-db
```

## Продвинутые команды

```bash
# Удалить неиспользуемые образы
docker image prune -a

# Очистить все (осторожно!)
docker system prune -a

# Информация о Docker на сервере
docker info

# Использование диска
docker system df

# Backup базы данных
docker exec secondlayer-payments-db pg_dump -U financemanager payments_db > backup.sql

# Restore базы данных
cat backup.sql | docker exec -i secondlayer-payments-db psql -U financemanager payments_db
```

## Docker Context команды

```bash
# Список контекстов
docker context ls

# Информация о контексте
docker context inspect gate-server

# Обновить контекст
docker context update gate-server --description "New description"

# Удалить контекст
docker context rm gate-server

# Экспорт контекста (для использования на другой машине)
docker context export gate-server
```

## Создание дополнительных контекстов

Если нужно подключиться к другому серверу:

```bash
# Создать новый контекст
docker context create another-server \
  --description "Another remote server" \
  --docker "host=ssh://user@server.com"

# Использовать
docker context use another-server
```

## Troubleshooting

### SSH Connection Issues

Если возникают проблемы с подключением:

```bash
# Проверить SSH доступ
ssh vovkes@gate.lexapp.co.ua "docker ps"

# Проверить SSH ключи
ssh-add -l

# Переподключить контекст
docker context rm gate-server
docker context create gate-server \
  --description "Gate Server (legal.org.ua)" \
  --docker "host=ssh://vovkes@gate.lexapp.co.ua"
```

### Permission Denied

Если получаете ошибку "permission denied":

```bash
# Проверить, что пользователь в группе docker на сервере
ssh vovkes@gate.lexapp.co.ua "groups"

# Должно быть: vovkes ... docker ...
```

### Slow Performance

Docker команды через SSH могут быть медленнее:

```bash
# Использовать SSH мультиплексирование для ускорения
# Добавить в ~/.ssh/config:
cat >> ~/.ssh/config << 'SSHEOF'

Host gate.lexapp.co.ua
  ControlMaster auto
  ControlPath ~/.ssh/controlmasters/%r@%h:%p
  ControlPersist 10m
SSHEOF

# Создать директорию для control sockets
mkdir -p ~/.ssh/controlmasters
```

## Интеграция с IDE

### VS Code Docker Extension

1. Установите расширение "Docker" от Microsoft
2. В настройках (Settings) найдите "Docker: Host"
3. Переключайте контексты через UI или используйте команду:
   ```
   Cmd+Shift+P → Docker Contexts: Use
   ```

### Docker Desktop GUI

В Docker Desktop в верхнем меню появится dropdown для выбора контекста. Просто выберите "gate-server" для управления удаленными контейнерами через GUI.

## Важные заметки

1. **Безопасность**: Все команды выполняются через SSH туннель, что безопасно
2. **Контекст по умолчанию**: После перезапуска терминала активируется `desktop-linux`
3. **Compose файлы**: Должны быть доступны локально или через SSH
4. **Volumes**: Пути к volume относятся к удаленному серверу, не к локальной машине
5. **Производительность**: Команды могут быть медленнее из-за сетевой задержки

## Часто используемые workflow

### Проверить статус приложения

```bash
docker context use gate-server && \
docker ps --filter "name=secondlayer" && \
docker stats --no-stream secondlayer-payment-frontend secondlayer-payment-server secondlayer-payments-db
```

### Перезапустить приложение после изменений

```bash
docker context use gate-server && \
ssh vovkes@gate.lexapp.co.ua "cd /opt/secondlayer-console && docker compose -f docker-compose.gate-server.yml restart"
```

### Мониторинг логов в реальном времени

```bash
docker context use gate-server && \
docker logs -f --tail 100 secondlayer-payment-server
```

### Вернуться к локальному Docker

```bash
docker context use desktop-linux
```

## Aliases для удобства

Добавьте в `~/.zshrc` или `~/.bashrc`:

```bash
# Docker на gate server
alias dgctx='docker context use gate-server'
alias dlctx='docker context use desktop-linux'
alias dgps='docker context use gate-server && docker ps'
alias dglogs='docker context use gate-server && docker logs -f'
alias dgstats='docker context use gate-server && docker stats'

# SecondLayer shortcuts
alias slps='docker context use gate-server && docker ps --filter "name=secondlayer"'
alias sllogs='docker context use gate-server && docker logs -f secondlayer-payment-server'
alias slrestart='docker context use gate-server && docker restart secondlayer-payment-frontend secondlayer-payment-server'
```

После добавления:
```bash
source ~/.zshrc  # или ~/.bashrc
```

Теперь можно использовать:
```bash
dgps           # docker ps на gate server
sllogs         # логи SecondLayer backend
slrestart      # перезапуск контейнеров
```
