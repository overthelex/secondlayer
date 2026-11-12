# ARTIFICIAL INTELLIGENCE USAGE POLICY

## for the LEX AI Service

*Last updated: March 14, 2026*

---

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 47-Sadova, 1a, Kyiv 04132, Ukraine
Email: info@legal.org.ua

## 1. General Provisions

This Artificial Intelligence Usage Policy (hereinafter — "AI Policy") describes the principles, limitations, and guarantees related to the use of artificial intelligence technologies (hereinafter — "AI") within the LEX AI service (hereinafter — "Service").

This AI Policy is an integral part of the Terms of Service and applies together with the Privacy Policy, Public Offer, and Data Processing Agreement (DPA).

## 2. AI Technologies Used by the Service

The LEX AI Service uses artificial intelligence models for:

- **Legal document analysis** — automatic identification of document type, parties, dates, key terms, and risks;
- **Semantic search** — searching court decisions and legislation by meaning, not just keywords;
- **Response generation** — producing legal explanations, document summaries, and analytical conclusions;
- **Classification and routing** — automatic query categorization for optimal search strategy selection;
- **Vector embeddings** — converting text into numerical vectors for semantic document comparison;
- **Citation verification** — validating references to legislation and court decisions.

### 2.1. External AI Providers

The Service uses APIs from third-party providers to process queries:

| Provider | Purpose | Server Location |
|----------|---------|----------------|
| Anthropic (Claude Opus, Sonnet, Haiku) via AWS Bedrock | Primary text analysis, response generation | EU (Frankfurt) |
| OpenAI (GPT-4o, GPT-4o-mini) | Auxiliary text analysis, response generation | USA, EU |
| OpenAI (text-embedding-3-small) | Vector embeddings | USA, EU |

The Company may change the list of AI providers by notifying Users through the Service interface or via email.

### 2.2. Internal Infrastructure

- **Qdrant** — vector database for storing and searching embeddings (deployed on Company servers in the EU);
- **PostgreSQL** — storing analysis results, caching (Company servers in the EU);
- **Redis** — caching intermediate AI processing results (Company servers in the EU).

## 3. How User Data Is Processed

### 3.1. Input Data

When using AI functions of the Service, the following data is processed:
- User's text queries;
- uploaded documents (PDF, DOCX, HTML, TXT, RTF);
- conversation context (previous messages in the chat session).

### 3.2. Data Minimization Principle

The Service transmits only the minimum necessary data to AI providers:
- User's query and relevant context;
- document fragments (not the full text, but only relevant sections);
- system instructions for the model (containing no personal data).

### 3.3. Prohibition on Training with User Data

User data is **NOT** used for:
- training or fine-tuning AI models;
- improving base models of providers (OpenAI API is used with the training-on-data option disabled; Anthropic does not use data transmitted through AWS Bedrock for model training);
- creating publicly available datasets;
- transfer to third parties for any purpose other than direct query processing.

### 3.4. Storage and Deletion

- AI queries and responses are stored in the User's chat history;
- Users can delete any AI conversation through the Service interface;
- After deletion, data is removed from the database within 30 days;
- Cached AI responses are automatically deleted after the cache period expires (1 to 30 days depending on data type);
- Data deletion is subject to restrictions imposed by Legal Hold (if applicable).

## 4. Limitations and Disclaimers

### 4.1. AI Analysis Is Not Legal Advice

**IMPORTANT:** AI analysis results are for informational and reference purposes only.

The Company does **NOT** guarantee:
- complete accuracy, timeliness, or completeness of results;
- correct citation of legislation or court decisions;
- applicability of results to a specific legal situation;
- absence of so-called "hallucinations" — cases where AI generates non-existent norms or decisions.

### 4.2. Hallucination Protection

The Service employs a multi-level system to protect against AI errors:
- **HallucinationGuard** — automatic verification of generated references against real sources;
- **CitationValidator** — validation of citations from legislation and court decisions;
- **Sources** — each AI response includes references to the sources used for independent verification.

Despite these measures, the Company cannot guarantee the complete absence of errors. Users are obligated to independently verify critically important information.

### 4.3. Usage Restrictions

Users agree **NOT** to use the AI functions of the Service for:
- generating deliberately false legal information;
- creating fake court decisions or legislation;
- automated mass generation of legal documents without verification;
- bypassing AI security or filtering systems;
- any purposes that violate the laws of Ukraine or applicable law.

## 5. Transparency and Accountability

### 5.1. AI Content Labeling

All AI-generated responses are clearly labeled in the Service interface. Users always see:
- that the response was generated by AI;
- which tools and sources were used;
- the cost of query processing (for billing transparency).

### 5.2. Cost Tracking

The Service maintains detailed records of AI resource usage:
- number of tokens (input and output) for each query;
- model and processing type (quick/standard/deep);
- cost of each query.

This information is available to Users in their profile section.

### 5.3. Logging

All AI operations are logged for the purposes of:
- diagnostics and Service quality improvement;
- security incident investigation;
- compliance with legal requirements.

Logs do not contain the full text of User documents — only operation metadata.

## 6. User Rights Regarding AI Processing

Users have the right to:
- **obtain an explanation** — request how AI reached a specific conclusion (through sources and tools indicated in the response);
- **opt out of AI processing** — use only manual search tools without AI analysis;
- **delete data** — delete all AI conversations and uploaded documents;
- **export data** — receive a copy of their data, including AI query history;
- **challenge results** — report erroneous or incorrect AI analysis results to info@legal.org.ua.

## 7. AI Processing Security

### 7.1. Technical Measures

- data encryption during transmission to AI providers (TLS 1.3);
- isolation of different Users' data (matter-based segregation);
- restricted access to AI functions through authentication (JWT + OAuth);
- rate limiting to prevent abuse;
- anomalous activity monitoring.

### 7.2. Organizational Measures

- only authorized personnel have access to AI processing data;
- regular review and updating of AI models and prompts;
- Data Protection Impact Assessment (DPIA) before implementing new AI features.

## 8. Regulatory Compliance

The Company strives to comply with:
- **Ukraine's Law "On Artificial Intelligence"** (upon adoption);
- **EU AI Act** (Regulation EU 2024/1689) — to the extent applicable to low-risk AI systems;
- **GDPR** — regarding automated decision-making (Art. 22);
- **Ukraine's Law "On Personal Data Protection"**.

The Service is classified as a **low-risk** AI system under the EU AI Act because:
- it does not perform automated legally binding decision-making;
- it provides only informational support, with the final decision made by the User;
- it does not use biometric data or special category data for AI processing.

## 9. Changes to This Policy

The Company may update this Policy in connection with:
- changes in AI providers or models;
- changes in legislation;
- expansion of the Service's AI functionality.

Users will be notified of material changes at least 14 days in advance through the Service interface or email.

## 10. Our Quality Guarantee

The Company guarantees that every AI analysis result undergoes automatic verification through built-in safety mechanisms:

### 10.1. HallucinationGuard — Standard for All Results

HallucinationGuard is a mandatory component in processing every AI query. This mechanism:
- analyzes every AI response for potentially non-existent norms, articles, or court decisions;
- cross-references generated citations with real legislation and court practice databases;
- blocks or flags responses containing unverified information;
- ensures transparency — Users see the system's confidence level for each conclusion.

### 10.2. CitationValidator — Standard for All Results

CitationValidator automatically verifies every citation in AI responses:
- validates article, part, and clause numbers of legislation;
- verifies the existence of cited court decisions;
- compares citation text with the original source;
- notifies Users of any detected discrepancies.

### 10.3. Error Reporting

If a User discovers an error in AI analysis results:
1. Report the error through the Service interface or to info@legal.org.ua;
2. Specify the exact query, response, and nature of the error;
3. We will analyze the report and take measures to prevent similar errors;
4. Upon request, we will notify the User of the review results.

The Company strives to continuously improve protection mechanisms and reduce AI errors.

## 11. Contact Information

For questions regarding AI usage in the Service:
- Email: info@legal.org.ua
- Website: https://legal.org.ua

---

*This Policy takes effect upon publication on the Service website.*
