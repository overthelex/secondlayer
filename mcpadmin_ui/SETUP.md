# Frontend Setup Guide

## 1. Установка зависимостей

```bash
cd frontend
npm install
```

## 2. Настройка API ключа

### Вариант A: Через .env файл (рекомендуется)

Создайте файл `.env` в папке `frontend/`:

```bash
# API Configuration
VITE_API_URL=http://localhost:3000/api
VITE_SECONDARY_LAYER_KEY=ваш-секретный-ключ
```

### Вариант B: Через системные переменные окружения

```bash
export VITE_SECONDARY_LAYER_KEY="ваш-секретный-ключ"
npm run dev
```

### Вариант C: Inline при запуске

```bash
VITE_SECONDARY_LAYER_KEY="ваш-секретный-ключ" npm run dev
```

## 3. Запуск

```bash
npm run dev
```

Откройте http://localhost:5173

## Как работает авторизация

### Data Provider с Authorization Header

Создан кастомный data provider (`src/providers/data-provider.ts`), который:

1. Использует axios для HTTP запросов
2. Автоматически добавляет `Authorization: Bearer <token>` ко всем запросам
3. Читает токен из переменной окружения `VITE_SECONDARY_LAYER_KEY`

### Interceptor

```typescript
axiosInstance.interceptors.request.use((config) => {
  const token = import.meta.env.VITE_SECONDARY_LAYER_KEY;
  
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  
  return config;
});
```

### Валидация

При старте приложения проверяется наличие API ключа:

```
⚠️  VITE_SECONDARY_LAYER_KEY is not set. API calls may fail.
```

## Установленные пакеты

```json
{
  "axios": "^1.7.9",           // HTTP client
  "query-string": "^9.1.1",    // Query params parsing
  "@refinedev/core": "^4.54.1",
  "@refinedev/antd": "^5.42.3",
  "lucide-react": "^0.462.0",
  "antd": "^5.21.6"
}
```

## Структура проекта

```
frontend/
├── src/
│   ├── providers/
│   │   ├── data-provider.ts  # Кастомный provider с auth
│   │   └── index.ts
│   ├── config/
│   │   └── env.ts            # Env validation
│   ├── pages/                # UI страницы
│   ├── styles/               # Темы и стили
│   └── App.tsx
├── .env                      # Ваши переменные (не в git)
├── .env.example              # Пример конфигурации
└── package.json
```

## Troubleshooting

### 401 Unauthorized

Проблема: `Missing or invalid Authorization header`

**Решение:**
1. Проверьте `.env` файл - там должен быть `VITE_SECONDARY_LAYER_KEY`
2. Перезапустите dev-сервер (Vite не подхватывает изменения .env на лету)
3. Проверьте в DevTools Network tab наличие header `Authorization: Bearer ...`

### Токен не передается

**Важно:** Все переменные окружения в Vite должны начинаться с `VITE_`!

```bash
# ✅ Правильно
VITE_SECONDARY_LAYER_KEY=key

# ❌ Неправильно (не будет доступно)
SECONDARY_LAYER_KEY=key
```

### Проверка конфигурации

Откройте консоль браузера и выполните:

```javascript
console.log(import.meta.env.VITE_SECONDARY_LAYER_KEY);
```

Если `undefined` - перезапустите dev-сервер.

## Production Build

При сборке продакшен версии:

```bash
VITE_SECONDARY_LAYER_KEY="ваш-ключ" npm run build
```

Или используйте `.env.production`:

```bash
# .env.production
VITE_API_URL=https://api.example.com
VITE_SECONDARY_LAYER_KEY=production-key
```

## Безопасность

- ✅ `.env` добавлен в `.gitignore`
- ✅ Используйте `.env.example` для документации
- ⚠️ Никогда не коммитьте реальные ключи в git
- ⚠️ В production используйте переменные окружения сервера, а не .env файлы
