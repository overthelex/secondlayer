# SSE (Server-Sent Events) Streaming API

## Обзор

HTTP API поддерживает Server-Sent Events (SSE) для streaming ответов от длительных операций. Это особенно полезно для инструмента `get_legal_advice`, который выполняет несколько шагов и может занимать значительное время.

## Использование SSE

### Вариант 1: Accept Header

Отправьте запрос с заголовком `Accept: text/event-stream`:

```bash
curl -N -H "Authorization: Bearer your-key" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"query": "затримка доставки", "reasoning_budget": "standard"}}' \
  http://localhost:3000/api/tools/get_legal_advice
```

### Вариант 2: Dedicated Stream Endpoint

Используйте специальный endpoint `/stream`:

```bash
curl -N -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"arguments": {"query": "затримка доставки"}}' \
  http://localhost:3000/api/tools/get_legal_advice/stream
```

**Важно:** Используйте флаг `-N` в curl для отключения буферизации.

## Формат SSE Событий

### Типы событий

1. **`connected`** - Подключение установлено
2. **`progress`** - Прогресс выполнения (промежуточные шаги)
3. **`complete`** - Финальный результат
4. **`error`** - Ошибка выполнения
5. **`end`** - Поток завершен

### Структура события

```
id: <event-id>
event: <event-type>
data: <json-data>

```

### Пример потока для `get_legal_advice`

```
id: connection
event: connected
data: {"tool":"get_legal_advice","timestamp":"2024-01-15T10:00:00.000Z"}

id: step-1
event: progress
data: {"step":1,"action":"intent_classification","message":"Класифікація наміру запиту...","progress":0.1}

id: step-1-complete
event: progress
data: {"step":1,"action":"intent_classification","message":"Намір визначено: consumer_penalty_delay","progress":0.2,"result":{"intent":"consumer_penalty_delay","confidence":0.95}}

id: step-2
event: progress
data: {"step":2,"action":"precedent_search","message":"Пошук релевантних прецедентів...","progress":0.3}

id: step-2-complete
event: progress
data: {"step":2,"action":"precedent_search","message":"Знайдено 15 справ","progress":0.4,"result":{"count":15}}

id: step-3
event: progress
data: {"step":3,"action":"section_extraction","message":"Витягнення семантичних секцій з документів...","progress":0.5}

id: step-3-doc-1
event: progress
data: {"step":3,"action":"section_extraction","message":"Обробка документа 1/5...","progress":0.54,"current":1,"total":5}

id: step-3-complete
event: progress
data: {"step":3,"action":"section_extraction","message":"Витягнуто 12 релевантних секцій","progress":0.7,"result":{"chunks":12}}

id: step-4
event: progress
data: {"step":4,"action":"pattern_matching","message":"Пошук релевантних паттернів...","progress":0.75}

id: step-4-complete
event: progress
data: {"step":4,"action":"pattern_matching","message":"Знайдено 3 паттернів","progress":0.85,"result":{"patterns":3}}

id: step-5
event: progress
data: {"step":5,"action":"validation","message":"Перевірка джерел та валідація відповіді...","progress":0.9}

id: final
event: complete
data: {"summary":"Знайдено 15 релевантних справ...","confidence_score":0.95,...}

id: end
event: end
data: {"message":"Stream completed"}
```

## JavaScript/TypeScript Пример

```typescript
async function streamLegalAdvice(query: string, apiKey: string) {
  const response = await fetch('http://localhost:3000/api/tools/get_legal_advice/stream', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      arguments: {
        query,
        reasoning_budget: 'standard',
      },
    }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (!reader) {
    throw new Error('Stream not available');
  }

  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    let event: { id?: string; event?: string; data?: string } = {};

    for (const line of lines) {
      if (line.startsWith('id: ')) {
        event.id = line.substring(4);
      } else if (line.startsWith('event: ')) {
        event.event = line.substring(7);
      } else if (line.startsWith('data: ')) {
        event.data = line.substring(6);
      } else if (line === '') {
        // Empty line = end of event
        if (event.event && event.data) {
          handleSSEEvent(event.event, JSON.parse(event.data));
        }
        event = {};
      }
    }
  }
}

function handleSSEEvent(type: string, data: any) {
  switch (type) {
    case 'connected':
      console.log('Connected to stream');
      break;
    case 'progress':
      console.log(`Progress: ${data.message} (${(data.progress * 100).toFixed(0)}%)`);
      updateProgressBar(data.progress);
      break;
    case 'complete':
      console.log('Complete result:', data);
      displayResult(data);
      break;
    case 'error':
      console.error('Error:', data.message);
      break;
    case 'end':
      console.log('Stream ended');
      break;
  }
}
```

## Python Пример

```python
import requests
import json

def stream_legal_advice(query: str, api_key: str):
    url = 'http://localhost:3000/api/tools/get_legal_advice/stream'
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    data = {
        'arguments': {
            'query': query,
            'reasoning_budget': 'standard',
        }
    }

    response = requests.post(url, headers=headers, json=data, stream=True)

    current_event = {}
    for line in response.iter_lines():
        if line:
            line = line.decode('utf-8')
            
            if line.startswith('id: '):
                current_event['id'] = line[4:]
            elif line.startswith('event: '):
                current_event['event'] = line[7:]
            elif line.startswith('data: '):
                current_event['data'] = json.loads(line[6:])
        else:
            # Empty line = end of event
            if 'event' in current_event and 'data' in current_event:
                handle_sse_event(current_event['event'], current_event['data'])
            current_event = {}

def handle_sse_event(event_type: str, data: dict):
    if event_type == 'connected':
        print('Connected to stream')
    elif event_type == 'progress':
        progress = data.get('progress', 0) * 100
        print(f"Progress: {data.get('message')} ({progress:.0f}%)")
    elif event_type == 'complete':
        print('Complete result:', json.dumps(data, indent=2, ensure_ascii=False))
    elif event_type == 'error':
        print(f"Error: {data.get('message')}")
    elif event_type == 'end':
        print('Stream ended')
```

## Поддерживаемые инструменты

В настоящее время streaming поддерживается для:

- ✅ **`get_legal_advice`** - Полный streaming с прогресс-событиями для каждого шага

Для других инструментов streaming работает, но отправляет только начальное и финальное событие.

## Преимущества SSE

1. **Реальное время** - Клиент видит прогресс выполнения
2. **Лучший UX** - Пользователь не ждет в неведении
3. **Отладка** - Легче понять, на каком этапе происходит ошибка
4. **Масштабируемость** - Меньше таймаутов для длительных операций

## Обработка ошибок

Если происходит ошибка, вы получите событие `error`:

```
event: error
data: {"message":"Error description","error":"Error details"}
```

После ошибки поток будет закрыт событием `end`.

## Переподключение

SSE поддерживает автоматическое переподключение через заголовок `Last-Event-ID`. Если соединение разорвано, клиент может отправить:

```
GET /api/tools/get_legal_advice/stream?lastEventId=step-3-doc-2
```

Однако, в текущей реализации переподключение не поддерживается - каждый запрос начинается с начала.

## Ограничения

- Максимальное время соединения: зависит от настроек сервера
- Буферизация: некоторые прокси могут буферизовать SSE события
- HTTP/2: SSE работает лучше с HTTP/1.1

## Best Practices

1. Всегда обрабатывайте событие `end` для корректного закрытия соединения
2. Обрабатывайте события `error` для информирования пользователя
3. Используйте `progress` события для обновления UI
4. Не полагайтесь на порядок событий - используйте `id` для отслеживания состояния
