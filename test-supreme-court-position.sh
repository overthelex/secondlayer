#!/bin/bash

echo "=========================================="
echo "Тестування позиції Верховного Суду"
echo "=========================================="
echo ""
echo "Запит: Яка позиція ВС щодо поновлення строку на апеляційне оскарження"
echo "       у разі несвоєчасного отримання повного тексту рішення?"
echo ""
echo "Використовуємо інструмент: calculate_procedural_deadlines"
echo "Цей інструмент автоматично аналізує практику ВС"
echo ""

# Використовуємо calculate_procedural_deadlines без автентифікації
# (публічний endpoint для тестування)
curl -s -X POST http://localhost:3000/api/tools/calculate_procedural_deadlines \
  -H "Content-Type: application/json" \
  -d '{
    "procedure_code": "cpc",
    "event_type": "рішення",
    "event_date": "2026-01-10",
    "appeal_type": "апеляція",
    "reasoning_budget": "standard",
    "practice_limit": 20
  }' > /tmp/deadline_result.json

# Перевірка результату
if [ -s /tmp/deadline_result.json ]; then
    echo "✓ Відповідь отримано"
    echo ""
    echo "Висновок:"
    cat /tmp/deadline_result.json | jq -r '.conclusion.summary' 2>/dev/null || echo "Обробка..."
    echo ""
    echo "Умови:"
    cat /tmp/deadline_result.json | jq -r '.conclusion.conditions' 2>/dev/null || echo "Обробка..."
    echo ""
    echo "Ризики:"
    cat /tmp/deadline_result.json | jq -r '.conclusion.risks' 2>/dev/null || echo "Обробка..."
else
    echo "✗ Помилка отримання відповіді"
fi

echo ""
echo "=========================================="
echo "Повний результат збережено в /tmp/deadline_result.json"
echo "=========================================="
