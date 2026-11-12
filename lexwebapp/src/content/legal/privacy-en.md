# PRIVACY POLICY

## LEX AI Platform

*Last updated: March 14, 2026*

---

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04132, Ukraine, Kyiv, 47-Sadova, 1a
Email: info@legal.org.ua
Data Protection Contact: info@legal.org.ua

## 1. Introduction

This Privacy Policy describes how Individual Entrepreneur Kyrychenko Igor Viktorovych (hereinafter — "Company", "we") collects, processes, stores, and protects personal data of users of the LEX AI service (hereinafter — "Service").

The Company processes personal data in accordance with:
- the Law of Ukraine "On Personal Data Protection" (No. 2297-VI);
- the General Data Protection Regulation (GDPR, Regulation 2016/679) — for EU/EEA users;
- other applicable regulations.

By using the Service, you confirm that you have read this Policy and consent to the processing of your personal data as described below.

## 2. Data We Collect

**2.1. Data you provide directly:**
- name, surname, email (during registration);
- profile photo (when authorizing via Google or Diia);
- documents you upload for AI analysis;
- text queries to the AI system;
- comments on blog articles.

**2.2. Data collected automatically:**
- IP address and approximate geolocation;
- browser type and operating system;
- session time and duration;
- actions within the Service interface (pages viewed, tools used);
- API usage (number of requests, tool types).

**2.3. Data from third parties:**
- Google profile (name, email, photo) — when authorizing via Google OAuth;
- Diia.Signature data (full name, tax ID) — when authorizing via Diia;
- payment information from Monobank (transaction status, without card number).

**2.4. Attorney data (for Attorneys registered on the Platform):**
- license number and issuance date for the License to practice law;
- data from the Unified Register of Attorneys of Ukraine (URAU);
- specialization, experience, biography;
- bank details (IBAN, bank name) for payouts;
- profile photo;
- rates and service conditions.

## 3. Purposes of Data Processing

We process personal data for the following purposes:

**3.1. Service provision:**
- creating and managing user accounts;
- performing AI analysis of uploaded documents;
- semantic search and retrieval of legal information;
- storing documents in the secure vault.

**3.2. Security and quality:**
- protection against unauthorized access;
- monitoring service quality and performance;
- detecting and preventing abuse.

**3.3. Communication:**
- sending service notifications (registration confirmation, password reset);
- notifying about changes to Terms or Policy.

**3.4. Legal obligations:**
- compliance with legal requirements;
- accounting records (payment data).

**3.5. Marketplace operation:**
- Attorney verification (data verification in the URAU);
- transfer of Client materials to the Attorney (with the Client's explicit consent when creating an Order);
- storage of communication logs between the Client and the Attorney (for dispute and complaint resolution);
- processing of escrow payments and Attorney payouts;
- rating calculation and review moderation.

## 4. Legal Basis for Processing (GDPR)

For EU/EEA users, we process data based on:
- **Consent** (Art. 6(1)(a) GDPR) — for optional features and marketing;
- **Performance of contract** (Art. 6(1)(b) GDPR) — for providing the Service;
- **Legitimate interest** (Art. 6(1)(f) GDPR) — for security and Service improvement;
- **Legal obligation** (Art. 6(1)(c) GDPR) — for compliance with legal requirements.

## 5. Document Processing via AI (Anthropic, OpenAI)

**IMPORTANT:** When using AI analysis, the content of your documents and queries is transmitted to AI providers for processing.

The Service uses multiple AI providers:

**5.1. Primary provider — Anthropic (via AWS Bedrock):**
- Claude models (Opus, Sonnet, Haiku) are the primary route for AI query processing;
- access to Anthropic models is provided through AWS Bedrock (Amazon Web Services);
- data is processed on AWS servers in the EU region (eu-central-1, Frankfurt);
- AWS Bedrock does **NOT** retain input or output data after processing;
- Anthropic does **NOT** use data transmitted through AWS Bedrock for training its models;
- processing is governed by a Data Processing Addendum (DPA) between the Company and AWS;
- AWS holds SOC 2 Type 2, ISO 27001, ISO 27017, and ISO 27018 certifications.

**5.2. Secondary provider — OpenAI:**
- GPT-4o and GPT-4o-mini models are used as an auxiliary processing route;
- the text-embedding-3-small model is used for creating vector embeddings;
- OpenAI acts as a sub-processor and processes data solely according to our instructions;
- OpenAI does **NOT** use API data for training its models (by default since March 1, 2023);
- data is retained by OpenAI for up to 30 days solely for abuse monitoring, after which it is deleted;
- processing is governed by a Data Processing Addendum (DPA) between the Company and OpenAI;
- OpenAI holds SOC 2 Type 2 certification.

Recommendations for users:
- do not upload documents with particularly sensitive personal data (medical, financial) unless necessary for analysis;
- anonymize documents before uploading when possible;
- contact us if you require additional safeguards for processing sensitive data.

## 6. Data Storage and Security

**6.1. Where data is stored:**
- user accounts and metadata — PostgreSQL (encrypted connections);
- documents — MinIO (S3-compatible storage with encryption);
- vector embeddings — Qdrant (for semantic search);
- session cache — Redis (temporary storage).

**6.2. Security measures:**
- data encryption in transit (TLS 1.2+);
- end-to-end document encryption (E2EE) at the User's option — document content is encrypted in the browser using AES-256-GCM, keys are stored exclusively on the User's side (X25519 + Argon2id KDF), the Company has no technical ability to decrypt such documents;
- JWT token authentication;
- role-based access control;
- audit log with hash chain for access tracking;
- data isolation between clients (matter segregation);
- regular backups.

**6.2.1. End-to-End Document Encryption (E2EE):**
At the User's option, documents may be protected with end-to-end encryption. In this case:
- document metadata (title, type, date) is stored in plaintext to enable search and filtering;
- semantic embeddings are stored in Qdrant for semantic search;
- document content (full text) is encrypted and stored in encrypted form;
- if the encryption password and backup key file are lost, access to encrypted documents cannot be recovered.

**6.3. Retention periods:**
- account data — duration of the account + 30 days after deletion;
- uploaded documents — duration of the account, deleted upon request;
- usage logs — 90 days;
- payment data — 5 years (legal requirement);
- AI query data — up to 30 days (OpenAI abuse monitoring; AWS Bedrock does not retain data after processing);
- Marketplace communication logs — 12 months from Order completion date;
- Attorney verification data — duration of the Attorney's account + 3 years;
- escrow transaction data — 5 years (legal requirement).

## 7. Data Sharing with Third Parties

We share personal data exclusively with the following categories of recipients:

**7.1. Sub-processors:**
- Amazon Web Services, Inc. (AWS Bedrock, EU/USA) — primary AI analysis of documents and queries (Anthropic Claude models);
- OpenAI, LP (USA) — auxiliary AI analysis and vector embeddings;
- Monobank / JSC "Universal Bank" (Ukraine) — payment processing;
- Cloudflare, Inc. (USA) — CDN and DDoS protection;
- Hetzner Online GmbH (Germany) — server hosting.

**7.1.1. Data sharing with Attorneys:**
Attorneys registered on the Platform receive access to Client data exclusively to the extent determined by the Client when creating an Order, and solely for the purpose of providing the legal Consultation. After Order completion, the Attorney's access to Client materials is automatically revoked after 7 (seven) calendar days.

The Attorney is an independent controller of the Client's personal data received in the course of providing the Consultation and is obligated to comply with attorney-client privilege requirements in accordance with Article 22 of the Law of Ukraine "On the Bar and Practice of Law."

Company personnel do not have access to the content of Consultations and case materials, except in cases of complaint review with the consent of both parties.

**7.2. Government authorities:**
- upon court order or lawful request in accordance with Ukrainian law.

We do **NOT** sell or share personal data for third-party marketing purposes.

For data transfers outside the EU/EEA, we use Standard Contractual Clauses (SCCs) pursuant to European Commission decisions.

## 8. Your Rights

Under applicable law and the GDPR, you have the following rights:

- **Right of access** (Art. 15 GDPR) — obtain information about what data we process;
- **Right to rectification** (Art. 16 GDPR) — correct inaccurate data;
- **Right to erasure** (Art. 17 GDPR) — request complete deletion of your data;
- **Right to restriction** (Art. 18 GDPR) — restrict processing of your data;
- **Right to data portability** (Art. 20 GDPR) — receive your data in a structured format;
- **Right to object** (Art. 21 GDPR) — object to processing based on legitimate interest;
- **Right to withdraw consent** — at any time without affecting the lawfulness of prior processing.

To exercise these rights:
- Data export: Profile → Privacy & Data → Export;
- Account deletion: Profile → Privacy & Data → Delete;
- Other requests: info@legal.org.ua.

We respond to requests within 30 days.

You also have the right to lodge a complaint with the Ukrainian Parliament Commissioner for Human Rights (Ukraine) or the supervisory authority in your EU country.

8.1. **Data Portability API.** The Client may use the REST API method `POST /api/user/export` to obtain their data in a machine-readable format (JSON). The export includes: profile, uploaded documents, AI query history, analysis results, Order history, and usage logs.

## 9. Automated Decision-Making

9.1. In accordance with Art. 22 GDPR, the Service does NOT make decisions with legal effects on the Client based solely on automated processing, including profiling.

9.2. AI analysis results are informational assistance only and do not replace professional legal advice. No Platform decision (including ratings, moderation, escrow payouts) is fully automated — all material decisions provide for the possibility of human intervention.

9.3. The Client has the right to request human review of any decision affecting their rights by contacting info@legal.org.ua.

## 10. Legitimate Interest Assessment

10.1. The Company processes certain categories of data based on legitimate interest (Art. 6(1)(f) GDPR) for the following purposes:
- ensuring Service security and fraud prevention;
- improving Service quality based on aggregated analytics;
- detecting and preventing abuse.

10.2. The Company has conducted a Legitimate Interest Assessment and determined that such processing does not override the rights and freedoms of data subjects.

10.3. The Client has the right to request a copy of the Legitimate Interest Assessment by contacting info@legal.org.ua.

## 11. Cookies

The Service uses:
- **essential cookies** — for authentication and session support (JWT tokens);
- **functional cookies** — for storing language settings and interface preferences.

We do **NOT** use third-party advertising or analytics cookies. We do **NOT** track users across other websites.

## 12. Children's Data Protection

The Service is not intended for persons under the age of 18. We do not knowingly collect personal data from minors. If you believe a minor has provided us with their data, please contact us for its deletion.

## 13. Changes to This Policy

We may update this Privacy Policy. We will notify you of material changes:
- via the email registered with your account;
- through notifications in the Service interface;
- at least 14 days before the changes take effect.

Continued use of the Service after changes constitutes acceptance of the updated Policy.

## 14. AI Quality and Safety

The Company implements comprehensive measures to ensure the quality and safety of AI data processing:

**14.1. Continuous Monitoring:**
- real-time automated monitoring of AI response quality;
- tracking citation and reference accuracy metrics through the CitationValidator system;
- monitoring HallucinationGuard performance to prevent generation of incorrect information.

**14.2. User Feedback Loop:**
- Users can report incorrect AI analysis results;
- every report is analyzed to improve Service quality;
- systematic analysis of feedback to enhance safety mechanisms.

**14.3. Regular Testing:**
- periodic testing of HallucinationGuard and CitationValidator mechanisms against current legal data;
- verification of semantic search accuracy and result relevance;
- assessment of AI error protection effectiveness.

**14.4. Safety Audits:**
- regular internal audits of AI data processing procedures;
- verification of compliance with personal data protection standards;
- Data Protection Impact Assessment (DPIA) when implementing new AI features.

For AI quality and safety inquiries, contact: info@legal.org.ua

## 15. Contact Information

For data protection inquiries, please contact:

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04132, Ukraine, Kyiv, 47-Sadova, 1a
Email: info@legal.org.ua
Website: https://legal.org.ua
