# Исправление ошибки 401 Authorization

## Проблема

```
Missing or invalid Authorization header. Use: Authorization: Bearer <SECONDARY_LAYER_KEY>
Error (status code: 401)
```

## Решение

### Шаг 1: Добавьте API ключ

Откройте файл `frontend/.env` и добавьте ваш ключ:

```bash
# API Configuration
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=ваш-реальный-api-ключ-здесь
```

### Шаг 2: Перезапустите dev-сервер

**Важно:** Vite не подхватывает изменения .env автоматически!

```bash
# Остановите текущий сервер (Ctrl+C)
# Затем запустите заново:
cd frontend
npm run dev
```

### Шаг 3: Проверьте в браузере

1. Откройте http://localhost:5173
2. Откройте DevTools (F12)
3. Перейдите на вкладку Network
4. Обновите страницу
5. Кликните на любой запрос к `/api/`
6. Проверьте Headers → Request Headers → должен быть:
   ```
   Authorization: Bearer ваш-ключ
   ```

## Что было сделано

### 1. Создан кастомный Data Provider

`src/providers/data-provider.ts` - добавляет Authorization header ко всем запросам

```typescript
axiosInstance.interceptors.request.use((config) => {
  const token = import.meta.env.VITE_SECONDARY_LAYER_KEY;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

### 2. Установлены зависимости

```bash
npm install axios query-string
```

### 3. Обновлен App.tsx

Теперь использует кастомный data provider вместо стандартного.

## Установленные пакеты для авторизации

```json
{
  "@refinedev/antd": "^5.42.3",
  "@refinedev/core": "^4.54.1",
  "@refinedev/react-router-v6": "^4.5.8",
  "antd": "^5.21.6",
  "axios": "^1.7.9",           // ← Для HTTP с interceptors
  "lucide-react": "^0.462.0",
  "query-string": "^9.1.1",    // ← Для query params
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "react-router-dom": "^6.28.0"
}
```

## Структура авторизации

```
frontend/
├── .env                          # ← Ваш секретный ключ здесь
├── .env.example                  # Пример конфигурации
├── src/
│   ├── providers/
│   │   ├── data-provider.ts     # ← Interceptor для auth
│   │   └── index.ts
│   ├── config/
│   │   └── env.ts               # Валидация переменных
│   ├── App.tsx                  # Использует кастомный provider
│   └── main.tsx                 # Проверяет env при старте
```

## Отладка

### Проверить переменные окружения

В консоли браузера:

```javascript
console.log(import.meta.env.VITE_SECONDARY_LAYER_KEY);
// Должен вывести ваш ключ, не undefined
```

### Если все равно 401

1. **Проверьте правильность ключа** - скопируйте из источника
2. **Перезапустите сервер** - обязательно! Ctrl+C и `npm run dev`
3. **Очистите кеш браузера** - Hard Reload (Ctrl+Shift+R)
4. **Проверьте backend** - возможно там другой формат ключа

### Проверить что headers отправляются

В DevTools → Network → любой запрос → Request Headers:

```
GET /api/documents HTTP/1.1
Host: localhost:3000
Authorization: Bearer your-key-here    ← Должен быть этот заголовок
Accept: application/json
...
```

## Альтернативные способы передачи ключа

### Через переменные окружения shell

```bash
VITE_SECONDARY_LAYER_KEY="ваш-ключ" npm run dev
```

### Через .env.local (приоритетнее .env)

```bash
# frontend/.env.local
VITE_SECONDARY_LAYER_KEY=production-key
```

## Безопасность

- ✅ `.env` добавлен в `.gitignore`
- ✅ Никогда не коммитьте `.env` в git
- ✅ Используйте `.env.example` для документации
- ⚠️ В production используйте переменные окружения сервера
