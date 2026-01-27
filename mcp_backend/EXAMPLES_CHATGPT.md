# ChatGPT Usage Examples

Real-world examples of using SecondLayer MCP tools in ChatGPT.

## Example 1: Simple Legislation Lookup

**User query:**
```
What does article 354 of the Civil Procedure Code say about appeal deadlines?
```

**What happens:**
1. ChatGPT calls `get_legislation_section` with:
   ```json
   {
     "query": "ст. 354 ЦПК"
   }
   ```

2. Server returns article text:
   ```
   Стаття 354. Строк подання апеляційної скарги

   Апеляційна скарга подається протягом тридцяти днів
   з дня складення повного судового рішення...
   ```

3. ChatGPT responds:
   > According to Article 354 of the Civil Procedure Code of Ukraine,
   > an appeal must be filed within 30 days from the date of preparation
   > of the full court decision...

## Example 2: Court Case Search

**User query:**
```
Find Supreme Court cases from 2023 about restoring missed appeal deadlines
```

**What happens:**
1. ChatGPT calls `search_supreme_court_practice`:
   ```json
   {
     "procedure_code": "cpc",
     "query": "поновлення пропущеного строку апеляції",
     "time_range": {
       "from": "2023-01-01",
       "to": "2023-12-31"
     },
     "court_level": "SC",
     "limit": 10
   }
   ```

2. Server returns 10 relevant cases with excerpts

3. ChatGPT summarizes findings with case citations

## Example 3: Legal Pattern Analysis

**User query:**
```
What are the common reasons courts accept for restoring missed appeal deadlines?
```

**What happens:**
1. ChatGPT calls `search_legal_precedents`:
   ```json
   {
     "query": "поновлення строку апеляції поважні причини",
     "domain": "court",
     "limit": 20
   }
   ```

2. ChatGPT calls `analyze_case_pattern`:
   ```json
   {
     "intent": "поновлення строку апеляції",
     "case_ids": ["110679112", "110441965", ...]
   }
   ```

3. Server returns:
   ```json
   {
     "success_arguments": [
       {
         "argument": "Несвоєчасне отримання повного тексту рішення",
         "frequency": 45,
         "success_rate": 0.72
       },
       {
         "argument": "Хвороба сторони з підтвердженням медичними документами",
         "frequency": 38,
         "success_rate": 0.65
       },
       ...
     ],
     "outcome_statistics": {
       "total_cases": 120,
       "satisfied": 68,
       "rejected": 52,
       "success_rate": 0.567
     }
   }
   ```

4. ChatGPT provides comprehensive answer with statistics

## Example 4: Complex Legal Analysis

**User query:**
```
I received the court decision 40 days after it was made due to postal delays.
Can I still file an appeal?
```

**What happens:**
1. ChatGPT calls `get_legal_advice`:
   ```json
   {
     "query": "Рішення отримано через 40 днів після ухвалення через поштові затримки. Чи можна подати апеляцію?",
     "reasoning_budget": "deep",
     "include_sources": true
   }
   ```

2. Server internally executes workflow:
   - Searches relevant legislation (`get_legislation_section`)
   - Finds similar cases (`search_legal_precedents`)
   - Analyzes patterns (`analyze_case_pattern`)
   - Validates sources (`validate_response`)
   - Formats answer (`format_answer_pack`)

3. Server returns structured answer:
   ```json
   {
     "position": "Так, можливо поновити строк апеляції",
     "norm": "Стаття 354, 366 ЦПК України",
     "reasoning": [
       "Несвоєчасне отримання через поштові затримки є поважною причиною",
       "Верховний Суд неодноразово задовольняв такі клопотання",
       "Необхідно подати клопотання про поновлення строку разом з апеляційною скаргою"
     ],
     "risks": [
       {
         "risk": "Відмова у поновленні, якщо не буде доказів затримки пошти",
         "severity": "medium",
         "mitigation": "Зберегти конверт з поштовим штампом як доказ"
       }
     ],
     "sources": [...]
   }
   ```

4. ChatGPT provides detailed advice with legal basis

## Example 5: Document Comparison

**User query:**
```
Compare these two contracts and highlight key differences
[uploads 2 PDF files]
```

**What happens:**
1. ChatGPT calls `compare_documents`:
   ```json
   {
     "document1_url": "https://...",
     "document2_url": "https://...",
     "comparison_type": "contracts"
   }
   ```

2. Server:
   - Parses both PDFs with OCR
   - Extracts key clauses
   - Performs semantic comparison
   - Identifies differences

3. Server returns:
   ```json
   {
     "differences": [
       {
         "section": "Payment Terms",
         "document1": "Payment within 30 days",
         "document2": "Payment within 14 days",
         "significance": "high"
       },
       ...
     ],
     "similarity_score": 0.78,
     "key_changes": [...]
   }
   ```

4. ChatGPT presents formatted comparison

## Example 6: Legislation Search by Topic

**User query:**
```
What are the procedural rules for submitting evidence in administrative cases?
```

**What happens:**
1. ChatGPT calls `search_legislation`:
   ```json
   {
     "query": "подання доказів адміністративне судочинство",
     "rada_id": "2747-15",
     "limit": 10
   }
   ```

2. Server finds relevant articles from КАС

3. ChatGPT calls `get_legislation_articles` for full text:
   ```json
   {
     "rada_id": "2747-15",
     "article_numbers": ["77", "78", "79", "80"]
   }
   ```

4. ChatGPT provides comprehensive answer with article references

## Example 7: Party Litigation History

**User query:**
```
How many cases has "ТОВ Інвестбуд" been involved in as defendant in the last 2 years?
```

**What happens:**
1. ChatGPT calls `count_cases_by_party`:
   ```json
   {
     "party_name": "ТОВ Інвестбуд",
     "party_type": "defendant",
     "date_from": "2022-01-01",
     "date_to": "2024-12-31",
     "return_cases": true,
     "max_cases_to_return": 50
   }
   ```

2. Server returns:
   ```json
   {
     "statistics": {
       "total_cases": 156,
       "as_defendant": 156,
       "by_court_type": {
         "commercial": 142,
         "civil": 14
       },
       "by_year": [
         {"year": "2022", "count": 67},
         {"year": "2023", "count": 89}
       ]
     },
     "outcome_statistics": {
       "satisfied": 45,
       "rejected": 98,
       "partial": 13
     },
     "cases": [...]
   }
   ```

3. ChatGPT presents analysis with trends

## Example 8: Citation Graph Analysis

**User query:**
```
Show me the citation network for Supreme Court case 756/655/23
```

**What happens:**
1. ChatGPT calls `get_citation_graph`:
   ```json
   {
     "case_id": "756/655/23",
     "depth": 2
   }
   ```

2. Server builds citation graph (cases citing this case + cases it cites)

3. Server returns graph structure with nodes and edges

4. ChatGPT describes the network:
   > Case 756/655/23 has been cited by 12 subsequent decisions,
   > including 3 Supreme Court cases. It itself cites 8 precedents,
   > most importantly case 123/456/20 from the Grand Chamber...

## Example 9: Pro/Contra Practice Analysis

**User query:**
```
Is there conflicting court practice on the issue of restoring appeal deadlines
for late receipt of full decision text?
```

**What happens:**
1. ChatGPT calls `compare_practice_pro_contra`:
   ```json
   {
     "procedure_code": "cpc",
     "query": "поновлення строку апеляції при несвоєчасному отриманні повного тексту",
     "time_range": {
       "from": "2020-01-01",
       "to": "2024-12-31"
     },
     "limit": 7
   }
   ```

2. Server finds both lines of practice (pro and contra)

3. Server analyzes:
   ```json
   {
     "pro_practice": {
       "summary": "Суди задовольняють клопотання при доведенні несвоєчасного отримання",
       "cases": [7 cases],
       "strength": "strong",
       "count": 45
     },
     "contra_practice": {
       "summary": "Суди відмовляють, якщо сторона не довела причини затримки",
       "cases": [7 cases],
       "strength": "moderate",
       "count": 28
     },
     "analysis": {
       "dominant_position": "pro",
       "confidence": 0.82,
       "key_distinction": "Наявність доказів затримки отримання",
       "recommendations": [...]
     }
   }
   ```

4. ChatGPT presents balanced analysis of both positions

## Example 10: Bulk Due Diligence

**User query:**
```
Review these 50 contracts for potential risks
[uploads folder with 50 PDFs]
```

**What happens:**
1. ChatGPT calls `bulk_review_runner`:
   ```json
   {
     "document_urls": ["url1", "url2", ...],
     "review_type": "contract_risk_assessment",
     "parallel_workers": 5
   }
   ```

2. Server processes documents in parallel:
   - Parses each PDF
   - Extracts key clauses
   - Identifies risks
   - Scores each document

3. ChatGPT calls `generate_dd_report`:
   ```json
   {
     "review_id": "bulk_12345",
     "format": "summary"
   }
   ```

4. Server returns formatted report:
   ```json
   {
     "summary": {
       "total_documents": 50,
       "high_risk": 8,
       "medium_risk": 15,
       "low_risk": 27
     },
     "critical_findings": [
       {
         "document": "Contract_23.pdf",
         "risk": "Missing dispute resolution clause",
         "severity": "high"
       },
       ...
     ],
     "recommendations": [...]
   }
   ```

5. ChatGPT presents executive summary with risk breakdown

## Tips for Best Results

### 1. Be Specific
❌ "Find cases about appeals"
✅ "Find Supreme Court cases from 2023 about restoring missed appeal deadlines in civil cases"

### 2. Provide Context
❌ "Check article 354"
✅ "Check article 354 of the Civil Procedure Code about appeal deadlines"

### 3. Use Ukrainian Terms
✅ "Знайди практику про поновлення строків"
✅ "Find practice about deadline restoration" (ChatGPT will translate)

### 4. Request Analysis
❌ "Show me cases"
✅ "Show me cases and analyze the success rate of similar arguments"

### 5. Chain Queries
Start broad, then drill down:
1. "Search for cases about X"
2. "Load full text of case #123"
3. "Analyze the court's reasoning in this case"
4. "Find similar cases with the same reasoning"

## Cost Information

Tool executions are tracked and billed. Typical costs:

- Simple queries (legislation lookup): $0.001-0.01
- Court case search: $0.03-0.10
- Pattern analysis: $0.02-0.08
- Full legal advice: $0.10-0.30
- Document parsing (PDF): $0.01-0.05
- Bulk operations: varies by volume

View your usage in the admin panel or cost_tracking table.

## Limits

- **Rate limits**: 100 requests/minute per user
- **SSE timeout**: 1 hour max per connection
- **Document size**: 50 MB max per upload
- **Batch size**: 100 documents max per batch
- **Search results**: 50 max per query (use pagination for more)

## Support

If a tool doesn't work or returns unexpected results:
1. Check tool name and arguments
2. View logs: `pm2 logs mcp-backend`
3. Check cost_tracking table for error details
4. Contact support with request_id from logs

## More Examples

See [CHATGPT_INTEGRATION.md](docs/CHATGPT_INTEGRATION.md) for:
- All 41 tools documentation
- Advanced usage patterns
- Authentication setup
- Troubleshooting guide
