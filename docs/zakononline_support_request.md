# Запит до технічної підтримки API Zakononline

## Тема: Відсутність доступу до endpoints ЄСПЛ та НПА

### Інформація про токени:
- Token 1: `E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B`
- Token 2: `DEC348-DDF5B0-45389B-7A4EB5-4A2BF2-C6AD0C-8DECCD-7A4886`

---

## Проблема 1: Практика ЄСПЛ (ECHR) недоступна

### Спроби доступу:

**1.1. Endpoint /api/echr/practice (404):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/api/echr/practice?limit=1"
```
**Результат:** `{"error":"Endpoint not found: /api/echr/practice?limit=1"}` (HTTP 404)

**1.2. Домен echr.searcher.api (timeout):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://echr.searcher.api.zakononline.com.ua/v1/search?limit=1"
```
**Результат:** Connection timeout (HTTP 000)

**1.3. Параметр mode=echr (ігнорується):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?mode=echr&limit=1"
```
**Результат:** Повертає звичайні судові рішення замість ЄСПЛ (HTTP 200, але неправильні дані)

---

## Проблема 2: НПА (нормативні акти) недоступні

### Спроби доступу:

**2.1. Endpoint /api/npa/search (404):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/api/npa/search?limit=1"
```
**Результат:** `{"error":"Endpoint not found: /api/npa/search?limit=1"}` (HTTP 404)

**2.2. Пошук з target=title (повертає судові рішення замість НПА):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?target=title&limit=1"
```
**Результат:** Повертає судові рішення замість НПА (HTTP 200, але неправильні дані)

**2.3. Пошук НПА з параметрами (400):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?target=title&mode=sph04&search=Конституція&limit=1"
```
**Результат:** Bad Request (HTTP 400)

**2.4. Метадані НПА (працює, але без даних):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search/meta?target=title"
```
**Результат:** `{"begin":0,"pages_num":12942853,"page":0,"total":129428526}` (HTTP 200)
**Проблема:** Повертає лише метадані, але не дозволяє отримати самі документи

---

## Проблема 3: Судова практика (застарілий endpoint)

**3.1. Endpoint /api/court/practice (404):**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/api/court/practice?limit=1"
```
**Результат:** `{"error":"Endpoint not found: /api/court/practice?limit=1"}` (HTTP 404)

---

## Що працює (для контролю):

**Базовий пошук судових рішень:**
```bash
curl -H "X-App-Token: E67988-51C592-408BA4-650017-3513F1-4B6EEC-B76ECD-4C4A2B" \
     -H "Accept: application/json" \
     "https://court.searcher.api.zakononline.com.ua/v1/search?target=text&mode=sph04&limit=1"
```
**Результат:** HTTP 200 ✅ (працює коректно)

---

## Питання до підтримки:

1. **ЄСПЛ:** Як отримати доступ до практики ЄСПЛ? Який правильний endpoint або параметри?

2. **НПА:** Як здійснювати пошук нормативних актів? Чому `/api/npa/search` повертає 404?

3. **Чи потрібен окремий токен** для доступу до ЄСПЛ та НПА, або наші токени мають обмежений доступ?

4. **Документація:** Чи є актуальна документація API з усіма доступними endpoints та параметрами?

---

## Очікуваний результат:

Можливість здійснювати пошук та отримувати:
- Рішення ЄСПЛ
- Нормативні акти України
- Судову практику (окрім базового пошуку `/v1/search`)

Дякуємо за допомогу!
