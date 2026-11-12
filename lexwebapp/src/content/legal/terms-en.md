# TERMS OF SERVICE

## LEX AI Platform

*Last updated: November 12, 2026*

---

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04207, Ukraine, Kyiv, 19 Levka Lukianenka St., apt. 110
Email: info@legal.org.ua

## 1. Definitions

"Service" — the LEX AI software available at legal.org.ua, including APIs, MCP servers, and the web application.
"Company" — Individual Entrepreneur Kyrychenko Igor Viktorovych, the operator of the Service.
"User" — any individual or legal entity using the Service.
"Content" — any data, documents, queries, and analysis results created or uploaded by the User.
"AI Analysis" — automated processing of legal documents using artificial intelligence.
"MCP Token" — an access key for connecting external MCP clients (Claude Desktop, etc.).

## 2. Acceptance of Terms

By registering an account or using the Service, you fully accept these Terms of Service, the Privacy Policy, and the Public Offer. If you disagree with any provision, discontinue use of the Service.

The Company reserves the right to modify these Terms. Users will be notified of material changes via email or through the Service interface at least 14 days before the changes take effect.

## 3. Description of the Service

LEX AI provides:
- AI analysis of legal documents (contracts, claims, court decisions);
- semantic search across Ukrainian court practice;
- legislation search and analysis;
- counterparty verification in state registries (EDR, EDRSR);
- secure document storage (vault);
- access to parliamentary data (bills, voting records);
- integration via MCP tokens with Claude Desktop and other clients.

The Service uses artificial intelligence technologies (Anthropic Claude models via AWS Bedrock as the primary route, OpenAI API as auxiliary) for processing and analyzing legal information.

## 4. AI Analysis Disclaimer

**IMPORTANT:** AI analysis results are for informational purposes only and do **NOT** constitute legal advice.

The Company does **NOT** guarantee:
- complete accuracy, currency, or completeness of analysis results;
- suitability of results for any specific legal situation;
- absence of errors in citations of legal acts or court decisions.

The User is obligated to independently verify AI analysis results before using them in legal practice. The Company shall not be liable for damages caused by the use of analysis results without proper verification.

### 4.1. AI Safety Mechanisms

The Service employs a multi-level protection system to minimize errors:

**HallucinationGuard** — incorrect information prevention system:
- automatically detects and prevents generation of non-existent legal norms, articles, or court decisions;
- verifies facts stated in AI responses by cross-referencing them with real sources;
- marks conclusions with low confidence levels using special indicators for additional User verification.

**CitationValidator** — citation validation system:
- validates every citation of legislation and court decisions against real sources;
- ensures that references to specific articles, parts, and clauses actually exist in the cited documents;
- warns the User about detected discrepancies between a citation and the original source.

These mechanisms significantly reduce the probability of errors but do **NOT** guarantee 100% accuracy of results. The User is obligated to independently verify critically important information.

## 5. Registration and Account

To use the Service, you must create an account using one of the following methods:
- registration via email and password;
- authorization via Google OAuth;
- authorization via Diia (Diia.Signature).

The User is obligated to:
- provide accurate information during registration;
- maintain the confidentiality of passwords and MCP tokens;
- immediately notify the Company of any unauthorized access;
- not transfer the account to third parties.

The Company reserves the right to block or delete an account in case of violation of these Terms.

**MCP Tokens and API Keys.** An MCP token is intended exclusively for connecting to the Service's MCP server at `https://mcp.legal.org.ua/api/v2/mcp` (header `Authorization: Bearer <token>` or OAuth sign-in) and for calling only the tools that the Service returns to the User in the list of available tools (`tools/list`) within their pricing plan. The User may connect the token to their own MCP clients and agents (Claude Desktop, Claude Code, Cursor, custom code) operating on their behalf. The following is prohibited:
- using the token on other Service addresses (`/v1/mcp`, `/v1/sse`, `/sse`, `/api/tools/*`, service and administrative interfaces, the web application), regardless of whether such an address technically accepts the token;
- calling or attempting to call tools not included in the list of available tools (including import, administration, bulk download and credential search tools), or circumventing a refusal by the Service;
- using a revoked, deactivated or replaced token after being notified of this, or enumerating or probing tokens that do not belong to the User;
- transferring the token to third parties, publishing it, or pasting it into third-party services that store or execute code (online sandboxes, chatbots, shared notebooks);
- creating additional accounts or tokens to circumvent limits.

All requests made with a token are logged (time, address, tool, IP address, client software, authentication outcome); the log constitutes evidence of a violation.

## 6. Acceptable Use

The User agrees to use the Service exclusively for lawful purposes. The following is prohibited:
- use for infringement of intellectual property rights;
- uploading malicious software;
- attempting unauthorized access to systems or data of other users;
- mass automated data downloading (scraping) without permission;
- using the Service to create competing products;
- exceeding established API limits without agreement;
- using analysis results to mislead courts or clients.

## 7. Intellectual Property

The LEX AI Service, including source code, design, algorithms, and documentation, is the intellectual property of the Company and is protected by copyright law.

Content uploaded by the User remains the User's property. The User grants the Company a limited license to process the Content solely for the purpose of providing the Service.

AI analysis results generated by the Service based on the User's Content belong to the User.

## 8. Pricing and Payment

The cost of services is determined by the selected plan published on the Service website.

Payments are made online through the Monobank payment system. Prices are listed in Ukrainian hryvnia (UAH) inclusive of VAT.

The Company reserves the right to change pricing with 30 days' prior notice. Price changes do not affect already paid periods.

## 9. Refunds

Refunds are available in the following cases:
- technical inability to provide services for more than 72 hours;
- erroneous charges;
- substantial documented deterioration in service quality.

Refund requests should be sent to info@legal.org.ua within 14 calendar days of the event. Refunds are processed within 10 business days.

No refund is made if access was terminated or a token deactivated due to a violation of these Terms, including the MCP token rules (Section 5): the unused balance is retained by the Company as a contractual penalty for breach under Articles 549 and 551 of the Civil Code of Ukraine, is not transferred to other accounts and is not credited against future payments.

## 10. Limitation of Liability

The Service is provided "as is." The Company does not guarantee uninterrupted operation and shall not be liable for:
- temporary unavailability of the Service for technical reasons;
- data loss due to actions of third parties or force majeure;
- damages resulting from improper use of the Service;
- actions or decisions made based on AI analysis results.

The Company's aggregate liability is limited to the amount paid by the User in the preceding 12 months.

## 11. Termination

The User may discontinue use of the Service at any time by deleting their account through profile settings or by sending a request to info@legal.org.ua.

The Company may terminate services:
- with 30 days' written notice;
- immediately — in case of material breach of these Terms.

If an MCP token is used outside the permitted scope (Section 5), the Company has the right to immediately and without notice deactivate that token or all of the User's tokens and terminate services; the remaining balance is not refunded in that case (Section 9). Access may be restored only by a separate decision of the Company.

After termination, the Company retains data for 30 days for possible recovery, after which it is deleted in accordance with the Privacy Policy.

## 12. Governing Law and Dispute Resolution

These Terms are governed by the laws of Ukraine.

Disputes shall be resolved through negotiation. If the parties fail to reach agreement within 30 days, the dispute shall be submitted to the court at the Company's registered address (Kyiv, Ukraine).

For users within the EU, the provisions of the GDPR (EU Regulation 2016/679) also apply.

## 13. Contact Information

Individual Entrepreneur Kyrychenko Igor Viktorovych
Tax ID (RNOKPP): 2967214056
Address: 04207, Ukraine, Kyiv, 19 Levka Lukianenka St., apt. 110
Email: info@legal.org.ua
Website: https://legal.org.ua
