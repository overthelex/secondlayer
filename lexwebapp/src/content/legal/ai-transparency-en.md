# AI TRANSPARENCY STATEMENT

## for the LEX AI Service

*Last updated: March 14, 2026*

---

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04132, Ukraine, Kyiv, 47-Sadova, 1a
Email: info@legal.org.ua

## 1. Purpose of This Statement

This AI Transparency Statement describes the safety mechanisms built into the LEX AI service to ensure the quality, accuracy, and reliability of AI-powered legal document analysis.

We believe that the legal domain demands the highest standards of accuracy, which is why we implement a multi-level system to protect against AI errors.

## 2. HallucinationGuard — AI Hallucination Protection

### 2.1. What Is HallucinationGuard

HallucinationGuard is a built-in safety mechanism that automatically verifies every AI response before it is presented to the User. The system prevents a common problem with AI models — generation of non-existent information (so-called "hallucinations").

### 2.2. How HallucinationGuard Works

The verification process includes several stages:

1. **Generated text analysis** — the system analyzes every AI response for specific legal claims: references to legislation articles, court decision numbers, dates, judge names, etc.

2. **Cross-referencing with sources** — every legal claim is verified against real databases:
   - Ukrainian legislation database (Verkhovna Rada, Zakon Online);
   - court decisions database (EDRS);
   - state registries (EDR, EDRPOU).

3. **Confidence assessment** — the system assigns a confidence level to each claim:
   - **High** — the claim is confirmed by a real source;
   - **Medium** — the claim is partially confirmed or the source requires additional verification;
   - **Low** — the claim is unconfirmed, marked with a special indicator.

4. **Filtering and labeling** — responses with unconfirmed claims are either blocked or labeled with warnings for the User.

### 2.3. What HallucinationGuard Verifies

- Existence of cited articles, parts, and clauses of legislation;
- Correspondence of court decision numbers to real EDRS records;
- Correctness of legislation effective dates;
- Correspondence of judge names to actual court compositions;
- Logical consistency of legal conclusions.

## 3. CitationValidator — Citation Validation

### 3.1. What Is CitationValidator

CitationValidator is a specialized mechanism that verifies every citation in AI responses. When AI references a specific article of law or court decision, CitationValidator confirms that the citation matches the original.

### 3.2. How CitationValidator Works

1. **Citation detection** — the system automatically identifies all references in the AI response to:
   - articles, parts, and clauses of laws and codes;
   - specific court decisions (by case number or registration number);
   - subordinate legislation (Cabinet of Ministers resolutions, ministerial orders, etc.).

2. **Original source retrieval** — for each citation, the system retrieves the original text from official sources:
   - Verkhovna Rada of Ukraine portal;
   - Unified State Register of Court Decisions;
   - other official databases.

3. **Text comparison** — the system compares the citation text in the AI response with the original and identifies:
   - full match — the citation is accurate;
   - partial match — minor differences exist (e.g., abbreviations);
   - mismatch — the text significantly differs from the original.

4. **User notification** — the verification result is displayed in the response:
   - confirmed citations include links to the original source;
   - detected discrepancies are accompanied by warnings.

### 3.3. CitationValidator Verification Types

| Verification Type | Description |
|-------------------|-------------|
| Norm existence | Whether the cited article/part/clause exists in the specified legislation |
| Norm validity | Whether the norm is in effect as of the current date |
| Text accuracy | Whether the cited text matches the original |
| Decision context | Whether the content of the court decision reference matches the actual decision |

## 4. Semantic Ranking

### 4.1. What Is Semantic Ranking

Semantic Ranking is an intelligent search result ranking system that ensures the most relevant documents appear at the top of results.

### 4.2. How Semantic Ranking Works

1. **Vector representation** — the User's query and documents in the database are converted into numerical vectors (embeddings) using OpenAI's text-embedding-3-small model. Text analysis and response generation are primarily performed by Anthropic Claude models (Opus, Sonnet, Haiku) via AWS Bedrock, with OpenAI models used as an auxiliary route.

2. **Semantic comparison** — the system compares the query vector with document vectors by meaning, not just keywords. This enables finding documents that match by content even when they use different terminology.

3. **Multi-factor ranking** — results are ranked by a combination of factors:
   - semantic similarity to the query;
   - court practice relevance (case category, court instance);
   - timeliness (decision date or latest amendments to legislation);
   - source authority (Supreme Court, appellate courts, etc.).

4. **Ranking transparency** — for each result, the User can see:
   - relevance score;
   - document source;
   - search tools used.

## 5. Comprehensive Safety System

The three described mechanisms work together, creating a comprehensive protection system:

```
User Query
     ↓
Semantic Ranking → finds the most relevant sources
     ↓
AI Analysis → generates a response based on real sources
     ↓
HallucinationGuard → verifies facts in the response
     ↓
CitationValidator → validates every citation
     ↓
Result → verified response with confirmed references
```

### 5.1. Benefits of the Comprehensive Approach

- **Accuracy** — multi-level verification significantly reduces the probability of errors;
- **Transparency** — Users see sources and confidence levels for each conclusion;
- **Traceability** — every processing step is logged for audit purposes;
- **Feedback** — errors identified by Users are used to improve the system.

### 5.2. Limitations

Despite the comprehensive approach, no AI system can guarantee 100% accuracy. Possible cases include:
- new or recently amended legislation may not yet be updated in the database;
- complex legal situations may require interpretation beyond AI capabilities;
- ambiguous wording in legislation may lead to different interpretations.

**Therefore, AI analysis results are an auxiliary tool and do NOT replace professional legal advice.**

## 6. Our Commitments

The Company commits to:

1. **Continuously improve** AI safety mechanisms based on User feedback and new technologies;
2. **Ensure transparency** — publish information about changes to the AI system and safety mechanism updates;
3. **Respond promptly** to error reports and take measures to resolve them;
4. **Maintain standards** — comply with EU AI Act, GDPR, and Ukrainian legislation requirements;
5. **Inform Users** — clearly label AI content and provide links to original sources.

## 7. Contact Information

For AI transparency and safety mechanism inquiries:

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04132, Ukraine, Kyiv, 47-Sadova, 1a
Email: info@legal.org.ua
Website: https://legal.org.ua

---

*This Statement takes effect upon publication on the Service website.*
