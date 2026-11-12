# DATA PROCESSING AGREEMENT

## DPA — LEX AI Platform

*Last updated: March 14, 2026*

---

This Data Processing Agreement ("DPA") is an integral part of the Terms of Service of the LEX AI platform ("Main Agreement") between:

**Processor:**
Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04132, Ukraine, Kyiv, 47-Sadova, 1a
Email: info@legal.org.ua
(hereinafter — "Processor", "Company", "LEX AI")

and

**Controller:**
The user or organization using the LEX AI Service
(hereinafter — "Controller", "Client")

This DPA becomes effective upon the Client's acceptance of the Service Terms of Use.

## 1. Definitions

"Personal Data" — any information relating to an identified or identifiable natural person, as defined in Art. 4(1) GDPR and the Law of Ukraine "On Personal Data Protection."

"Processing" — any operation performed on Personal Data: collection, recording, organization, storage, adaptation, alteration, retrieval, consultation, use, disclosure, dissemination, alignment, restriction, erasure, or destruction.

"Client Data" — Personal Data that the Client uploads, transmits, or otherwise provides through the Service, including documents for AI analysis, text queries, and metadata.

"Sub-processor" — a third party that processes Client Data on behalf of the Processor.

"Security Breach" — accidental or unlawful destruction, loss, alteration, unauthorized disclosure of, or access to Client Data.

"Standard Contractual Clauses" (SCCs) — standard contractual clauses for the transfer of personal data approved by the European Commission (Decision 2021/914).

"Applicable Data Protection Law" — GDPR, the Law of Ukraine "On Personal Data Protection," and other applicable regulations.

## 2. Roles and Responsibilities

2.1. The Client is the Data Controller — it determines the purposes and means of processing Personal Data.

2.2. The Company is the Data Processor — it processes Client Data solely based on the Controller's documented instructions and for the purpose of providing the Service.

2.3. If the Client is itself a processor (acting on behalf of its own client), the Company acts as a Sub-processor. In this case, Module 3 (Processor → Sub-processor) of the SCCs applies.

2.4. The Company does not independently determine the purposes of processing Client Data and does not use it for its own purposes, except as provided in this DPA.

2.5. In the context of the Legal Consultation Marketplace, the Company acts as a Processor of Client Data when providing technical infrastructure, and as an independent Controller when processing data for the purposes of escrow payments, Attorney verification, moderation, and dispute resolution.

2.6. An Attorney registered on the Platform is an independent Controller of the Client's personal data received in the course of providing a legal Consultation. The Attorney is obligated to comply with attorney-client privilege requirements in accordance with Article 22 of the Law of Ukraine "On the Bar and Practice of Law" and Applicable Data Protection Law.

## 3. Subject Matter and Scope of Processing

3.1. Subject matter: processing of Client Data for the purpose of providing AI analysis of legal documents, semantic search, document storage, and related Service functions, as well as ensuring the operation of the Legal Consultation Marketplace (escrow payments, verification, ratings, communication).

**3.2. Categories of data subjects:**
- clients and counterparties of the Client mentioned in documents;
- parties to legal proceedings;
- natural persons referenced in legal documents;
- Attorneys registered on the Platform;
- Clients ordering legal Consultations through the Marketplace.

**3.3. Types of personal data:**
- identification data (full name, tax ID, passport details);
- contact data (addresses, phone numbers, email);
- legal data (court case data, contracts, transactions);
- financial data (if contained in uploaded documents);
- Attorney verification data (License number, URAU data, bank details);
- communication logs between Clients and Attorneys (metadata, excluding content of secured Consultations);
- escrow transaction data (amounts, dates, payment and payout statuses).

3.4. Duration of processing: for the term of the Main Agreement + 30 days after its termination for data deletion.

## 4. Controller's Instructions

4.1. The Processor processes Client Data solely in accordance with the Controller's documented instructions, which include:
- uploading documents for AI analysis;
- executing search queries;
- storing documents in the vault;
- using MCP tools via API or web interface;
- creating Orders and using the Marketplace;
- transferring materials to the Attorney (with the Controller's explicit consent);
- confirming Order completion and initiating payouts.

4.2. The Client's use of the Service constitutes documented instructions for processing.

4.3. The Processor shall immediately inform the Controller if, in its opinion, an instruction violates Applicable Data Protection Law.

4.4. The Processor shall not process Client Data for purposes not covered by the Controller's instructions, except where required by law. In such cases, the Processor shall inform the Controller before processing, unless prohibited by law.

## 5. Confidentiality

5.1. The Processor ensures that persons authorized to process Client Data:
- have committed themselves to confidentiality or are under an appropriate statutory obligation;
- process data solely in accordance with the Controller's instructions.

5.2. The Processor limits access to Client Data to only those employees who require access to fulfill obligations under this DPA.

## 6. Security of Processing

6.1. The Processor implements and maintains appropriate technical and organizational measures to ensure a level of security appropriate to the risk (Art. 32 GDPR):

**Technical measures:**
- data encryption in transit (TLS 1.2+);
- data encryption at rest (PostgreSQL, MinIO);
- end-to-end document encryption (E2EE) — three-level envelope encryption (AES-256-GCM for documents, X25519 ECDH for key wrapping, Argon2id KDF for master secret protection), where encryption keys are stored exclusively on the Controller's side, and the Processor has no technical ability to decrypt the content of encrypted documents;
- JWT token authentication with limited validity;
- role-based access control (RBAC);
- data isolation between clients (matter segregation);
- audit log with hash chain for integrity assurance;
- automated vulnerability scanning.

**Organizational measures:**
- privacy by design and privacy by default principles;
- data minimization policy;
- regular backups with recovery testing;
- security incident response procedures;
- staff training on data protection.

6.2. The Processor regularly tests and evaluates the effectiveness of these measures.

## 7. Sub-processors

7.1. The Controller grants general prior authorization for the engagement of Sub-processors. List of approved Sub-processors:

| Sub-processor | Jurisdiction | Function | Transfer mechanism |
|---|---|---|---|
| Amazon Web Services, Inc. (AWS Bedrock) | EU (Frankfurt) / USA | Primary AI analysis of documents and queries (Anthropic Claude models) | SCCs + DPA |
| OpenAI, LP | USA | Auxiliary AI analysis and vector embeddings | SCCs + DPA |
| Monobank (JSC "Universal Bank") | Ukraine | Payment processing | National law |
| Cloudflare, Inc. | USA | CDN, DDoS protection, SSL | SCCs |
| Hetzner Online GmbH | Germany | Server hosting | Adequacy (EU) |
| Attorneys (registered on the Platform) | Ukraine | Provision of legal Consultations | Independent controllers |

7.2. The Processor shall notify the Controller of any addition or replacement of a Sub-processor at least 14 days before processing begins. The Controller has the right to object within 14 days of notification.

7.3. The Processor enters into an agreement with each Sub-processor that provides a level of protection no less than that provided in this DPA.

7.4. The Processor bears full responsibility for the acts and omissions of its Sub-processors.

**7.5. Specifics of processing through AWS Bedrock (Anthropic):**
- Anthropic Claude models (Opus, Sonnet, Haiku) are the primary AI processing route;
- AWS Bedrock does **NOT** retain input or output data after request processing is complete;
- Anthropic does **NOT** use data transmitted through AWS Bedrock for model training;
- processing is governed by a DPA between the Company and AWS;
- AWS holds SOC 2 Type 2, ISO 27001, ISO 27017, and ISO 27018 certifications.

**7.5.1. Specifics of processing through OpenAI:**
- OpenAI does **NOT** use API data for model training;
- data is retained for up to 30 days for abuse monitoring;
- processing is governed by a separate DPA between the Company and OpenAI;
- OpenAI holds SOC 2 Type 2 certification.

**7.6. Specifics of data processing by Attorneys:**
- Attorneys are independent data controllers for data received during Consultations, not sub-processors of the Company;
- the Company transfers Client data to the Attorney solely with the Client's explicit consent and to the extent determined by the Client;
- after Order completion, the Attorney's access to Client materials on the Platform is automatically revoked after 7 (seven) calendar days;
- the Attorney is independently responsible for ensuring compliance of their data processing with Applicable Data Protection Law;
- the content of Consultations conducted through secure channels (video, audio) is protected by attorney-client privilege — Company personnel do not have access to it.

## 8. International Data Transfers

8.1. Client Data may be transferred to the following jurisdictions:
- Germany (Hetzner) — EU adequacy decision;
- USA (OpenAI, Cloudflare, AWS) — Standard Contractual Clauses (SCCs).

8.2. For transfers to third countries without an adequacy decision, the Processor ensures:
- execution of SCCs (Commission Decision 2021/914);
- conducting a Transfer Impact Assessment;
- implementing supplementary measures if necessary.

8.3. The Processor provides the Controller with a copy of the relevant SCCs upon request.

## 9. Data Subject Rights

9.1. The Processor assists the Controller in fulfilling data subject requests regarding:
- right of access (Art. 15 GDPR);
- right to rectification (Art. 16 GDPR);
- right to erasure (Art. 17 GDPR);
- right to restriction of processing (Art. 18 GDPR);
- right to data portability (Art. 20 GDPR);
- right to object (Art. 21 GDPR).

9.2. If the Processor receives a request directly from a data subject, it shall promptly redirect it to the Controller, unless otherwise required by law.

**9.3. Technical means of implementation:**
- user data export (Profile → Privacy & Data → Export);
- account deletion (Profile → Privacy & Data → Delete);
- API requests via info@legal.org.ua.

## 10. Security Breach Notification

10.1. The Processor shall notify the Controller of a Security Breach without undue delay, but no later than 48 hours after discovery.

10.2. The notification shall include:
- a description of the nature of the breach;
- the categories and approximate number of affected data subjects;
- the name and contact details of the responsible person;
- a description of the likely consequences;
- measures taken or proposed to address the breach.

10.3. The Processor shall provide the Controller with sufficient information to fulfill its obligations regarding notification of the supervisory authority (Art. 33 GDPR) and data subjects (Art. 34 GDPR).

10.4. The Processor shall document all Security Breaches, including the facts, effects, and remedial actions taken.

## 11. Data Protection Impact Assessment (DPIA)

11.1. The Processor assists the Controller in conducting data protection impact assessments (Art. 35 GDPR) and prior consultations with the supervisory authority (Art. 36 GDPR) by providing necessary information about security measures and the nature of processing.

## 12. Audit

12.1. The Processor makes available to the Controller all information necessary to demonstrate compliance with obligations under this DPA.

12.2. The Processor permits and contributes to audits and inspections by the Controller or an authorized auditor:
- with prior notice of at least 30 days;
- no more than once per year (except in case of a Security Breach);
- subject to confidentiality obligations;
- during business hours and without material disruption to the Processor's operations.

12.3. If an audit requires access to other clients' data, the Processor may propose alternative verification measures (SOC 2 reports, certificates).

## 13. Deletion and Return of Data

13.1. Upon termination of the Main Agreement, the Processor shall, at the Controller's choice:
- return all Client Data in a standard machine-readable format (JSON); or
- delete all Client Data and existing copies.

13.2. Deletion shall be completed within 30 days of agreement termination.

13.3. The Processor may retain copies of data only if required by Applicable Law, with notification to the Controller of the grounds and scope of retention.

**13.4. Data transferred to Sub-processors is deleted according to the terms of agreements with Sub-processors:**
- AWS Bedrock: data is not retained after request processing;
- OpenAI: automatic deletion after 30 days;
- Cloudflare: cache deletion within 72 hours.

13.5. Data deletion in the Marketplace context:
- Client materials transferred to the Attorney: Platform access is revoked 7 days after Order closure;
- communication logs: retained for 12 months from Order completion date for dispute resolution purposes, then deleted;
- escrow transaction data: retained for 5 years in accordance with accounting legislation requirements;
- Attorney verification data: retained for the duration of the account + 3 years after deletion.

## 14. Liability

14.1. Each party is liable for breaches of this DPA in accordance with Applicable Data Protection Law and the Main Agreement.

14.2. The Processor shall indemnify the Controller for direct damages caused by breach of this DPA, within the limits defined in the Main Agreement.

14.3. Limitations of liability established in the Main Agreement apply to this DPA, except where such limitation contradicts Applicable Data Protection Law.

## 15. Term and Amendments

15.1. This DPA is effective for the term of the Main Agreement and automatically terminates together with it.

15.2. Obligations regarding confidentiality and data deletion survive termination of this DPA.

15.3. The Processor may update this DPA to reflect changes in legislation or processing practices. The Controller will be notified of material changes 14 days in advance.

## 16. Governing Law

16.1. This DPA is governed by the laws of Ukraine.

16.2. For Controllers within the EU/EEA, the GDPR also applies. In case of conflict between this DPA and the GDPR, the provisions of the GDPR shall prevail.

16.3. Disputes shall be resolved in accordance with the procedure defined in the Main Agreement.

## 17. Contact Information

For data processing and DPA inquiries:

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04132, Ukraine, Kyiv, 47-Sadova, 1a
Email: info@legal.org.ua
Website: https://legal.org.ua

## Annex A. Standard Contractual Clauses (SCCs)

For the transfer of Client Data to third countries without an adequacy decision, the parties agree to the application of Standard Contractual Clauses approved by European Commission Decision 2021/914 of June 4, 2021.

Applicable modules:
- Module 2 (Controller → Processor): when the Client is a Controller;
- Module 3 (Processor → Sub-processor): when the Client is a Processor.

Full text of the SCCs: https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj
