# JWT Token Generation Guide

Швидкий посібник для генерації JWT токенів для віддаленого MCP доступу.

---

## 🔑 Метод 1: Використання скрипта (Рекомендовано)

### Передумови:

```bash
cd mcp_backend

# Встановити залежності (якщо ще не зроблено)
npm install
```

### Генерація токена:

```bash
# Синтаксис:
npx tsx scripts/generate-jwt-token.ts [client-id] [expires-in]

# Приклад 1: Токен на 90 днів
npx tsx scripts/generate-jwt-token.ts my-app 90d

# Приклад 2: Токен на 1 рік
npx tsx scripts/generate-jwt-token.ts production-client 365d

# Приклад 3: Токен на 30 днів (за замовчуванням)
npx tsx scripts/generate-jwt-token.ts dev-client 30d

# Приклад 4: Токен без терміну дії (не рекомендовано)
npx tsx scripts/generate-jwt-token.ts eternal-client never
```

### Вивід скрипта:

```
🔑 SecondLayer MCP - JWT Token Generator
=========================================

Client ID:      my-app
Expires In:     90d

🎫 Generated Token:

eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJteS1hcHAiLCJpYXQiOjE3MzY2MDg4MDAsImV4cCI6MTc0NDM4NDgwMCwiaXNzIjoic2Vjb25kbGF5ZXItbWNwIn0.abc123def456...

📋 MCP Client Configuration:

{
  "mcpServers": {
    "SecondLayerMCP": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
      }
    }
  }
}

✅ Copy the configuration above to your MCP client config

🔍 Token Details:
   Subject (sub):  my-app
   Issued At (iat): 2026-01-18T12:00:00.000Z
   Expires At (exp): 2026-04-18T12:00:00.000Z
   Issuer (iss):    secondlayer-mcp
```

---

## 🔑 Метод 2: Онлайн генератор (jwt.io)

Якщо не маєте доступу до скрипта:

### Крок 1: Отримати JWT_SECRET

```bash
# З .env.production файлу
grep JWT_SECRET .env.production

# Або зв'яжіться з адміністратором
```

### Крок 2: Згенерувати токен

1. Перейдіть на **https://jwt.io/**
2. У розділі "Algorithm" виберіть **HS256**
3. У розділі "PAYLOAD" вставте:

```json
{
  "sub": "my-app",
  "iat": 1736608800,
  "exp": 1744384800,
  "iss": "secondlayer-mcp"
}
```

4. У розділі "VERIFY SIGNATURE" вставте ваш `JWT_SECRET`
5. Скопіюйте згенерований токен з лівої панелі

### Розрахунок timestamp:

```bash
# Current time (iat)
date +%s

# Expiration time (90 days from now)
date -v +90d +%s   # macOS
date -d "+90 days" +%s   # Linux
```

---

## 🔑 Метод 3: Node.js скрипт (один раз)

Створіть тимчасовий файл `generate-token.js`:

```javascript
const jwt = require('jsonwebtoken');

const jwtSecret = 'YOUR-JWT-SECRET-HERE';  // Замініть на ваш secret
const clientId = 'my-app';
const expiresIn = '90d';

const token = jwt.sign(
  {
    sub: clientId,
    iat: Math.floor(Date.now() / 1000),
  },
  jwtSecret,
  {
    expiresIn: expiresIn,
    issuer: 'secondlayer-mcp',
  }
);

console.log('Token:', token);

// Decode to check
const decoded = jwt.decode(token);
console.log('Expires at:', new Date(decoded.exp * 1000).toISOString());
```

Запустіть:

```bash
npm install jsonwebtoken
node generate-token.js
```

---

## 🔑 Метод 4: curl + API (майбутнє)

_В розробці: автоматичний API endpoint для генерації токенів_

```bash
curl -X POST https://mcp.legal.org.ua/api/auth/token \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR-ADMIN-KEY" \
  -d '{
    "client_id": "my-app",
    "expires_in": "90d"
  }'
```

---

## 📝 Параметри токена

### client_id (Subject)

Унікальний ідентифікатор клієнта. Використовуйте осмислені назви:

**Приклади:**
- `production-web-app` - продакшн веб застосунок
- `dev-mobile-app` - розробка мобільного застосунку
- `john-doe-laptop` - персональний ноутбук
- `research-bot` - бот для досліджень

### expires_in (Термін дії)

Формат: `<число><одиниця>`

**Одиниці:**
- `d` - дні (days)
- `h` - години (hours)
- `m` - хвилини (minutes)
- `s` - секунди (seconds)

**Приклади:**
- `7d` - 7 днів
- `30d` - 30 днів (місяць)
- `90d` - 90 днів (квартал)
- `365d` - 1 рік
- `never` - без терміну дії (не рекомендовано)

**Рекомендації:**
- **Dev/Testing:** 7-30 днів
- **Production:** 90-180 днів
- **Personal use:** 30-90 днів
- **Enterprise:** 180-365 днів

---

## 🔐 Безпека

### ⚠️ ВАЖЛИВО:

1. **Зберігайте JWT_SECRET в безпеці**
   - Не публікуйте в репозиторії
   - Не діліться з іншими
   - Використовуйте .env файли
   - Для production використовуйте .env.production

2. **Обмежуйте термін дії токенів**
   - Ніколи не створюйте токени "never" для production
   - Регулярно оновлюйте токени
   - Використовуйте короткі терміни для dev/test

3. **Один токен = один клієнт**
   - Не діліться токенами між користувачами
   - Кожен клієнт повинен мати свій токен
   - Відстежуйте які токени створені та для кого

4. **Відкликання токенів**
   - При компрометації токена згенеруйте новий
   - Змініть JWT_SECRET для відкликання всіх токенів
   - Ведіть лог виданих токенів

### Генерація нового JWT_SECRET:

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL
openssl rand -hex 32

# Python
python3 -c "import secrets; print(secrets.token_hex(32))"
```

---

## 🧪 Тестування токена

### Перевірка що токен працює:

```bash
# Замініть YOUR-TOKEN на згенерований токен
curl -X POST https://mcp.legal.org.ua/v1/sse \
  -H "Authorization: Bearer YOUR-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

### Перевірка деталей токена:

Перейдіть на https://jwt.io/ та вставте ваш токен в поле "Encoded". Ви побачите:

```json
{
  "sub": "my-app",
  "iat": 1736608800,
  "exp": 1744384800,
  "iss": "secondlayer-mcp"
}
```

**Важливо:** Не вставляйте production токени на публічні сайти!

---

## 📚 Приклади використання

### Приклад 1: Розробка

```bash
npx tsx scripts/generate-jwt-token.ts dev-laptop 30d
```

Використання в `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondlayer-dev": {
      "url": "https://mcp.legal.org.ua/v1/sse",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJIUz..."
      }
    }
  }
}
```

### Приклад 2: Production

```bash
npx tsx scripts/generate-jwt-token.ts production-web 180d
```

Зберегти токен у `.env`:

```bash
MCP_JWT_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Використання в коді:

```javascript
const mcpClient = new MCPClient({
  url: 'https://mcp.legal.org.ua/v1/sse',
  headers: {
    'Authorization': `Bearer ${process.env.MCP_JWT_TOKEN}`
  }
});
```

### Приклад 3: Множинні клієнти

```bash
# Веб застосунок
npx tsx scripts/generate-jwt-token.ts web-app 90d

# Мобільний застосунок
npx tsx scripts/generate-jwt-token.ts mobile-app 90d

# Бот для досліджень
npx tsx scripts/generate-jwt-token.ts research-bot 30d

# Персональний ноутбук
npx tsx scripts/generate-jwt-token.ts john-laptop 60d
```

Зберегти всі токени в безпечному місці (наприклад, 1Password, LastPass).

---

## 🆘 Troubleshooting

### Помилка: "JWT_SECRET not found"

```bash
# Перевірити .env.production
cat .env.production | grep JWT_SECRET

# Створити якщо немає
echo "JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env.production
```

### Помилка: "Token has expired"

Токен прострочений. Згенеруйте новий з більшим терміном дії.

### Помилка: "Invalid token"

1. Перевірте що використовується правильний JWT_SECRET
2. Перевірте формат токена (має бути три частини розділені крапками)
3. Згенеруйте новий токен

---

**Готово! Тепер ви можете генерувати JWT токени для віддаленого MCP доступу.** 🎉
