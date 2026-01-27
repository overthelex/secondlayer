# 📝 Приклади тестових запитів для MCP інструментів

Приклади curl команд для ручного тестування всіх інструментів.

## 🔐 Аутентифікація

Всі запити потребують API ключ:
```bash
-H "Authorization: Bearer test-key-123"
```

---

## SecondLayer Backend (localhost:3000)

### 🧭 Pipeline Core Tools

#### classify_intent
```bash
curl -X POST http://localhost:3000/api/tools/classify_intent \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Хочу оскаржити рішення суду першої інстанції"
  }'
```

#### retrieve_legal_sources
```bash
curl -X POST http://localhost:3000/api/tools/retrieve_legal_sources \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "договір позики",
    "limit": 5
  }'
```

#### validate_response
```bash
curl -X POST http://localhost:3000/api/tools/validate_response \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "response": "Згідно статті 1046 ЦК України позика повинна бути повернена",
    "sources": [{"type": "legislation", "reference": "ЦК України ст. 1046"}]
  }'
```

---

### 🔍 Search and Precedent Tools

#### search_legal_precedents
```bash
curl -X POST http://localhost:3000/api/tools/search_legal_precedents \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "стягнення боргу за договором позики",
    "limit": 10,
    "date_from": "2023-01-01"
  }'
```

#### analyze_case_pattern
```bash
curl -X POST http://localhost:3000/api/tools/analyze_case_pattern \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "розірвання договору оренди",
    "limit": 10
  }'
```

#### get_similar_reasoning
```bash
curl -X POST http://localhost:3000/api/tools/get_similar_reasoning \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "reasoning_text": "Позивач не довів факт порушення своїх прав відповідачем",
    "limit": 5
  }'
```

#### search_supreme_court_practice
```bash
curl -X POST http://localhost:3000/api/tools/search_supreme_court_practice \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "тлумачення норм цивільного права",
    "limit": 5
  }'
```

---

### 📄 Document Management Tools

#### get_court_decision
```bash
curl -X POST http://localhost:3000/api/tools/get_court_decision \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": "756/655/23"
  }'
```

#### extract_document_sections
```bash
curl -X POST http://localhost:3000/api/tools/extract_document_sections \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": "756/655/23",
    "use_llm": false
  }'
```

---

### 📊 Analytics Tools

#### count_cases_by_party
```bash
curl -X POST http://localhost:3000/api/tools/count_cases_by_party \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "party_name": "ПриватБанк",
    "role": "plaintiff"
  }'
```

#### get_citation_graph
```bash
curl -X POST http://localhost:3000/api/tools/get_citation_graph \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": "756/655/23",
    "depth": 2
  }'
```

#### check_precedent_status
```bash
curl -X POST http://localhost:3000/api/tools/check_precedent_status \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": "756/655/23"
  }'
```

---

### 📚 Legislation Tools

#### get_legislation_article
```bash
curl -X POST http://localhost:3000/api/tools/get_legislation_article \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "ЦПК",
    "article": "175"
  }'
```

#### get_legislation_section
```bash
curl -X POST http://localhost:3000/api/tools/get_legislation_section \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "reference": "ст. 625 ЦК"
  }'
```

#### search_legislation
```bash
curl -X POST http://localhost:3000/api/tools/search_legislation \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "апеляційне оскарження",
    "limit": 5
  }'
```

#### search_procedural_norms
```bash
curl -X POST http://localhost:3000/api/tools/search_procedural_norms \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "строки подачі апеляції"
  }'
```

---

### ⏱️ Procedural Tools

#### calculate_procedural_deadlines
```bash
curl -X POST http://localhost:3000/api/tools/calculate_procedural_deadlines \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "start_date": "2024-01-15",
    "procedure_type": "appeal"
  }'
```

#### build_procedural_checklist
```bash
curl -X POST http://localhost:3000/api/tools/build_procedural_checklist \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "procedure_type": "civil_lawsuit"
  }'
```

#### calculate_monetary_claims
```bash
curl -X POST http://localhost:3000/api/tools/calculate_monetary_claims \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "principal": 100000,
    "start_date": "2023-01-01",
    "end_date": "2024-01-01"
  }'
```

---

### 📝 Document Processing Tools

#### parse_document
```bash
curl -X POST http://localhost:3000/api/tools/parse_document \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "document_url": "https://example.com/contract.pdf",
    "extract_text": true
  }'
```

#### extract_key_clauses
```bash
curl -X POST http://localhost:3000/api/tools/extract_key_clauses \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "document_text": "Договір позики від 01.01.2024. Позичальник зобов'\''язується повернути суму 100000 грн до 31.12.2024."
  }'
```

#### summarize_document
```bash
curl -X POST http://localhost:3000/api/tools/summarize_document \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "document_text": "Договір позики. Сторони: ТОВ Компанія та Іванов І.І. Сума: 100000 грн. Термін: 31.12.2024.",
    "summary_type": "executive"
  }'
```

#### compare_documents
```bash
curl -X POST http://localhost:3000/api/tools/compare_documents \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "document1": "Договір від 01.01.2024. Сума: 100000 грн.",
    "document2": "Договір від 01.01.2024. Сума: 150000 грн."
  }'
```

---

### 🎯 Advanced Tools

#### get_legal_advice (Quick Mode)
```bash
curl -X POST http://localhost:3000/api/tools/get_legal_advice \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "situation": "Сусід затопив мою квартиру, завдав шкоди на 50000 грн. Відмовляється компенсувати.",
    "reasoning_budget": "quick"
  }'
```

#### get_legal_advice (Standard Mode)
```bash
curl -X POST http://localhost:3000/api/tools/get_legal_advice \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "situation": "Роботодавець незаконно звільнив мене без попередження та не виплатив зарплату за останній місяць.",
    "reasoning_budget": "standard"
  }'
```

#### format_answer_pack
```bash
curl -X POST http://localhost:3000/api/tools/format_answer_pack \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "norm": "ст. 1166 ЦК України",
    "position": "Власник зобов'\''язаний відшкодувати шкоду",
    "conclusion": "Позов підлягає задоволенню",
    "risks": ["Необхідність доказування розміру шкоди"]
  }'
```

---

## RADA MCP (localhost:3001)

### 📜 Parliament Bills

#### search_parliament_bills - Basic
```bash
curl -X POST http://localhost:3001/api/tools/search_parliament_bills \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "цифровізація",
    "limit": 10
  }'
```

#### search_parliament_bills - With Filters
```bash
curl -X POST http://localhost:3001/api/tools/search_parliament_bills \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "освіта",
    "status": "adopted",
    "date_from": "2023-01-01",
    "date_to": "2024-01-01",
    "limit": 5
  }'
```

#### search_parliament_bills - By Initiator
```bash
curl -X POST http://localhost:3001/api/tools/search_parliament_bills \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "інновації",
    "initiator": "Федоров",
    "limit": 10
  }'
```

---

### 👤 Deputy Information

#### get_deputy_info - Basic
```bash
curl -X POST http://localhost:3001/api/tools/get_deputy_info \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Федоров"
  }'
```

#### get_deputy_info - With Voting Record
```bash
curl -X POST http://localhost:3001/api/tools/get_deputy_info \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Шмигаль",
    "include_voting_record": true
  }'
```

#### get_deputy_info - With Assistants
```bash
curl -X POST http://localhost:3001/api/tools/get_deputy_info \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Стефанчук",
    "include_assistants": true
  }'
```

---

### 📖 Legislation Search

#### search_legislation_text - Constitution
```bash
curl -X POST http://localhost:3001/api/tools/search_legislation_text \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "law_identifier": "constitution",
    "article": "124"
  }'
```

#### search_legislation_text - Civil Code
```bash
curl -X POST http://localhost:3001/api/tools/search_legislation_text \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "law_identifier": "цивільний кодекс",
    "search_text": "позовна давність"
  }'
```

#### search_legislation_text - With Court Citations
```bash
curl -X POST http://localhost:3001/api/tools/search_legislation_text \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "law_identifier": "кпк",
    "article": "234",
    "include_court_citations": true
  }'
```

---

### 🗳️ Voting Analysis

#### analyze_voting_record - Basic
```bash
curl -X POST http://localhost:3001/api/tools/analyze_voting_record \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "deputy_name": "Федоров"
  }'
```

#### analyze_voting_record - With Date Range
```bash
curl -X POST http://localhost:3001/api/tools/analyze_voting_record \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "deputy_name": "Шмигаль",
    "date_from": "2023-01-01",
    "date_to": "2024-01-01"
  }'
```

#### analyze_voting_record - With AI Pattern Analysis
```bash
curl -X POST http://localhost:3001/api/tools/analyze_voting_record \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -d '{
    "deputy_name": "Стефанчук",
    "analyze_patterns": true,
    "date_from": "2023-06-01"
  }'
```

---

## 🔍 Debugging & Inspection

### List All Available Tools

**SecondLayer:**
```bash
curl -H "Authorization: Bearer test-key-123" \
  http://localhost:3000/api/tools | jq '.tools[] | {name, description}'
```

**RADA:**
```bash
curl -H "Authorization: Bearer test-key-123" \
  http://localhost:3001/api/tools | jq '.tools[] | {name, description}'
```

### Health Checks

```bash
# SecondLayer
curl http://localhost:3000/health

# RADA
curl http://localhost:3001/health
```

---

## 💡 Tips

### Pretty Print JSON
Додайте `| jq '.'` до будь-якого curl запиту:
```bash
curl ... | jq '.'
```

### Save Response to File
```bash
curl ... > response.json
```

### Time Request
```bash
time curl ...
```

### Debug with Verbose Output
```bash
curl -v ...
```

---

## 📦 Import to Postman

1. Створіть новий Collection
2. Додайте Environment Variables:
   - `base_url`: http://localhost:3000
   - `rada_url`: http://localhost:3001
   - `api_key`: test-key-123

3. Додайте Pre-request Script:
```javascript
pm.request.headers.add({
    key: 'Authorization',
    value: 'Bearer ' + pm.environment.get('api_key')
});
```

4. Імпортуйте приклади запитів з цього документу
