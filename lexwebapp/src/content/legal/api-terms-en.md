# API TERMS OF USE

## for developers of commercial solutions

*Last updated: November 12, 2026*

---

Limited Liability Company "Lex AI" (LLC "Lex AI")
EDRPOU code: 45269875
Address: 04132, Ukraine, Kyiv, 47-a Sadova St., 1a
Email: api@legal.org.ua

## 1. General Provisions

1.1. This document is an official offer by LLC "Lex AI" (hereinafter — the **"Provider"**), addressed to a legal entity or individual entrepreneur registered in accordance with the laws of its respective jurisdiction (hereinafter — the **"Developer"**), to enter into this Agreement on providing access to the LEX AI Platform API for commercial use (hereinafter — the **"Agreement"**) under the terms set forth below.

1.2. Individuals without business entity status cannot accept this offer.

1.3. Acceptance of this offer is:
- registration of a developer account on the Platform and generation of an API key; or
- the first API request using the issued API key,

whichever occurs first (Article 642 of the Civil Code of Ukraine).

1.4. From the moment of acceptance, the Agreement is considered concluded and has legal force in accordance with Articles 633, 641, and 642 of the Civil Code of Ukraine.

1.5. This Agreement operates in conjunction with the Terms of Use, Privacy Policy, and Data Processing Agreement (DPA) published on the Platform, to the extent they do not conflict with this Agreement. In the event of a conflict between the provisions of this Agreement and the general Terms of Use, the provisions of this Agreement shall prevail.

## 2. Definitions

**"Platform"** or **"LEX AI"** — the software product "SecondLayer," available at legal.org.ua, including API endpoints, MCP servers, and the web application.

**"API"** (Application Programming Interface) — the Platform's programming interface that allows the Developer to integrate LEX AI functionality into their own software products via HTTP requests, MCP protocol, or SSE connections.

**"API Key"** — a unique authentication identifier (a string of the form `sl_…`) provided to the Developer for API access.

**"Permitted Endpoint"** — the API address on which the API Key may be used. The only Permitted Endpoint is the Platform's MCP server at `https://mcp.legal.org.ua/api/v2/mcp` (MCP protocol, Streamable HTTP transport), unless otherwise agreed with the Provider in writing.

**"Permitted Tools"** — the MCP server tools that the Platform returns in response to a `tools/list` request for the specific account and API Key, and that are included in the Developer's pricing plan or agreed in a separate agreement.

**"Revoked Key"** — an API Key that has been deactivated or revoked by the Provider or the Developer, has expired, or has been replaced by a new key.

**"SaaS Product"** — Software as a Service created by the Developer using the Platform API, which the Developer provides to its End Users on a commercial basis.

**"End User"** — an individual or legal entity that uses the Developer's SaaS Product.

**"API Request"** — a single call from the SaaS Product to the Platform API.

**"Rate Limit"** — the maximum number of API Requests permitted during a specified time period according to the selected pricing plan.

**"Competing Product"** — a software product whose core functionality duplicates or replaces the core functions of the LEX AI Platform as defined in clause 4.3 of this Agreement.

**"White-label"** — use of the Platform API functionality in the Developer's SaaS Product under the Developer's own brand.

## 3. Subject of the Agreement

3.1. The Provider grants the Developer a non-exclusive, revocable, limited license to use the Platform API for creating and commercially operating SaaS Products under the terms defined in this Agreement.

3.2. The license includes the right to:
- make API Requests to the Platform in accordance with the technical documentation;
- integrate API Request results into the Developer's SaaS Product;
- provide End Users with access to functionality obtained through the API;
- use API results for commercial purposes, including white-label solutions.

3.3. The license does not include the right to:
- access the Platform's source code;
- modify, decompile, or reverse-engineer the API or Platform;
- transfer the API Key or rights under this Agreement to third parties;
- resell API access as a standalone service.

## 4. Permitted and Prohibited Use

4.1. **Permitted Use.** The Developer may create any SaaS Products using the API, except for Competing Products as defined in clause 4.3.

4.2. **White-label.** The Developer may use API results under their own brand (white-label) subject to compliance with attribution requirements (Section 5).

4.3. **Prohibited Competing Products.** The Developer is prohibited from creating SaaS Products whose core functionality reproduces the combination of the following Platform functions:
- AI analysis of legal documents with semantic search across Ukrainian court decisions;
- comprehensive search and analysis of Ukrainian legislation;
- counterparty verification in Ukrainian state registries (USR, USCR);
- secure storage of legal documents with AI processing.

Use of individual API functions (for example, only registry search or only document analysis) for building specialized products does not constitute creating a Competing Product.

4.4. **General Restrictions.** The Developer is prohibited from:
- exceeding established Rate Limits;
- taking actions that disrupt the stability or security of the API;
- using the API for unlawful purposes;
- providing End Users with direct access to the API Key;
- using API results to train competing artificial intelligence models;
- mass automated data extraction (scraping) for the purpose of accumulating databases beyond normal API usage.

4.5. In case of doubt regarding the permissibility of specific use, the Developer is obligated to contact the Provider for prior approval.

4.6. **Scope of Access under the API Key. Permitted:**
- using the API Key exclusively on the Permitted Endpoint (`/api/v2/mcp`) with the header `Authorization: Bearer <key>` or via OAuth authorization of the Developer's account;
- calling only Permitted Tools within the Rate Limits and the selected pricing plan;
- connecting the key to the Developer's own software products and to MCP clients (Claude Desktop, Claude Code, Cursor, custom agents) operating on behalf of the Developer;
- storing the key in the Developer's own infrastructure or in the infrastructure of a contractor bound by a confidentiality obligation.

4.7. **Scope of Access under the API Key. Prohibited:**
- using the API Key on any other Platform endpoints, including `/v1/mcp`, `/v1/sse`, `/sse`, `/api/tools/*`, service, internal and administrative interfaces, and the web application, regardless of whether such an endpoint technically accepts the key;
- calling or attempting to call tools that are not Permitted Tools, including data import, administration, bulk download and credential search (OSINT) tools, or circumventing a Platform refusal (responses with codes `TOOL_FORBIDDEN`, `API_KEY_V2_ONLY`);
- making requests with a Revoked Key after notice of its revocation or replacement, or enumerating, guessing or probing keys that do not belong to the Developer;
- transferring the key to third parties or End Users, publishing it in open source code, pasting it into third-party services that store or execute code (online sandboxes, chatbots, shared notebooks), or using one key for several independent products or customers;
- creating additional accounts or keys in order to circumvent Rate Limits or other restrictions;
- using results obtained through the API to systematically copy the Platform's databases.

4.8. **Logging.** All requests made with an API Key are logged by the Provider (time, endpoint, tool, IP address, client software, response size, authentication outcome). The log constitutes proper evidence of the fact and extent of a breach of the scope of access.

## 5. Attribution and Branding

5.1. **Mandatory Attribution.** The Developer is required to display prominent labeling **"Powered by LEX AI"** in their SaaS Product in every location where End Users are shown results obtained through the Platform API.

5.2. **Placement Requirements.** The attribution label must be:
- visually prominent and legible;
- placed directly next to API results or in the footer of the page/screen where these results are displayed;
- a hyperlink to https://legal.org.ua (for web products).

5.3. **Logo.** The Provider supplies the Developer with a set of official logos and brand guidelines for attribution use. The Developer agrees not to modify the Provider's logo.

5.4. **White-label Exception.** For white-label solutions, reduced attribution in the form of a text link in the interface footer is permitted. Complete removal of attribution is possible only by separate written agreement with the Provider and may entail additional fees.

5.5. **Prohibition of Misrepresentation.** The Developer may not:
- present API functionality as their own development without attribution;
- use the Provider's trademarks in a manner that creates an impression of official partnership or affiliation without written consent;
- use the name "LEX AI" or "SecondLayer" in the name of their SaaS Product.

## 6. Pricing and Payment Terms

6.1. **Payment Model.** Payment is made on a pay-per-call basis — for each API Request in accordance with the rates published on the Platform at legal.org.ua/api-pricing.

6.2. **Pricing Plans.** The Provider establishes pricing plans that define:
- the cost per API Request depending on the tool type;
- Rate Limits (requests per minute / hour / month);
- included request volume (if provided by the pricing plan);
- available API tool types.

6.3. **Prepayment.** The Developer tops up the balance on the Platform with an advance payment. API Requests are automatically deducted from the balance. When the balance reaches zero, API access is suspended until replenishment.

6.4. **Currency.** Payment is made in Ukrainian hryvnia (UAH). For non-residents of Ukraine, the Provider may accept payment in US dollars (USD) or euros (EUR) at the exchange rate set by the Provider at the time of payment.

6.5. **Invoices and Reporting.** The Provider provides the Developer with:
- real-time API Request details in the personal dashboard;
- a monthly summary invoice by the 5th business day of the following month;
- a certificate of completed works (services rendered) for Ukrainian residents.

6.6. **Rate Changes.** The Provider has the right to change rates with prior notice of 30 (thirty) calendar days. Rate changes do not affect already paid and unused funds on the balance.

6.7. **Taxes.** The Provider is a single tax payer, Group 3. VAT is not charged. The Developer is independently responsible for paying taxes and fees in accordance with the laws of their jurisdiction.

## 7. Service Level Agreement (SLA)

7.1. **API Availability.** The Provider guarantees API availability at a level of **99.9%** (ninety-nine point nine percent) during each calendar month, corresponding to no more than 43 minutes of downtime per month.

7.2. **Availability Calculation.** Availability is calculated as:

```
Availability = (Total minutes in month − Minutes of downtime) / Total minutes in month × 100%
```

7.3. **Downtime Exclusions.** The following are not counted as downtime:
- scheduled maintenance for which the Provider gave 48 hours' notice (no more than 4 hours per month);
- downtime caused by actions of the Developer or their End Users;
- force majeure circumstances (Section 13);
- downtime of external services on which the API depends (OpenAI, AWS, etc.).

7.4. **SLA Breach Compensation.** In the event of a breach of the guaranteed availability level, the Developer is entitled to compensation in the form of balance credit:

| Actual Availability | Credit (% of monthly spend) |
|---|---|
| 99.0% — 99.9% | 10% |
| 95.0% — 99.0% | 25% |
| Below 95.0% | 50% |

7.5. **Compensation Procedure.** The Developer submits a compensation request within 10 business days after the end of the calendar month in which the SLA breach occurred. Credit is applied to the balance within 5 business days.

7.6. **Maximum Compensation.** Total compensation for SLA breaches for one calendar month may not exceed 50% of the amount spent by the Developer on API Requests for that month.

7.7. **API Response Time.** The Provider makes commercially reasonable efforts to ensure API response times of:
- simple requests (registry search, document retrieval): up to 2 seconds;
- complex requests (AI analysis, semantic search): up to 30 seconds;
- streaming requests (SSE streaming): response start within 5 seconds.

Response times are target metrics, not guarantees.

## 8. Data Processing and Privacy

8.1. **End User Data Processing.** The Provider processes data transmitted through the API (document texts, queries, chat context) solely for the purpose of executing API Requests and providing responses. The Provider does not use End User data for AI model training, marketing, or any other purposes unrelated to servicing the API Request.

8.2. **Data Isolation.** The Provider ensures logical isolation of each Developer's data. Data transmitted through one Developer's API is not accessible to other Developers or Platform End Users.

8.3. **Data Retention.** The Provider retains API Request logs (metadata: time, request type, volume) for 90 days for billing and diagnostics purposes. Request and response content is retained for 30 days. The Developer may request early deletion of request content.

8.4. **No Content Access.** The Provider guarantees that no Provider employee has access to the content of API Requests and responses, except in cases of:
- technical diagnostics at the Developer's request;
- compliance with legal requirements or court orders.

8.5. **Use of Sub-processors.** To provide API services, the Provider uses third-party services (AWS, Anthropic, OpenAI). The Provider ensures that sub-processors process data under terms no less strict than those defined in this Agreement. The current list of sub-processors is published on the Platform.

8.6. **Developer's Data Obligations.** The Developer:
- is independently responsible for obtaining End User consent for the transmission of their data through the Platform API;
- is obligated to inform End Users that their data is processed using third-party services (LEX AI, AI models);
- ensures compliance of data processing with the laws of the jurisdiction in which their SaaS Product operates;
- does not transmit through the API any data whose processing is prohibited by law or contradicts this Agreement.

8.7. **Incident Notification.** In the event of a security incident affecting the Developer's data or their End Users' data, the Provider notifies the Developer no later than **24 (twenty-four) hours** from the moment of discovery.

## 9. Intellectual Property

9.1. **Provider's Rights.** All intellectual property rights to the Platform, API, documentation, algorithms, AI models, and the trademarks "LEX AI" and "SecondLayer" belong exclusively to the Provider.

9.2. **Developer's Rights.** The Developer retains all intellectual property rights to their SaaS Product, except for components belonging to the Provider.

9.3. **API Results.** Results obtained through the API (analytical conclusions, search results, structured data) may be used by the Developer for commercial purposes within the SaaS Product. The Developer does not acquire intellectual property rights to the algorithms or models that generate these results.

9.4. **Feedback.** If the Developer provides the Provider with suggestions, feedback, or ideas for API improvements, the Provider has the right to use them without restrictions and without compensation.

## 10. Confidentiality

10.1. **Confidential Information** — any information transmitted by one Party to the other in connection with the performance of this Agreement, including:
- API technical documentation that is not publicly available;
- API keys and credentials;
- commercial terms and discounts;
- data on API usage volumes;
- business plans and development strategy.

10.2. The Parties undertake not to disclose Confidential Information to third parties and to use it solely for the purposes of performing this Agreement.

10.3. Confidentiality obligations remain in effect for **3 (three) years** after termination of this Agreement.

## 11. Liability and Limitations

11.1. **Provider's Liability Limitation.** The Provider's aggregate liability under this Agreement is limited to the amount actually paid by the Developer for API services during the last 12 (twelve) months preceding the occurrence of the basis for liability.

11.2. **Exclusion of Liability.** The Provider shall not be liable for:
- indirect, incidental, or punitive damages, including lost profits, data loss, or reputational damage;
- damages to End Users of the Developer's SaaS Product;
- service interruptions caused by sub-processors (AWS, OpenAI, Anthropic), except for SLA breach compensation in accordance with Section 7;
- the accuracy, completeness, or currency of AI analysis results.

11.3. **Developer's Liability.** The Developer bears full responsibility to their End Users for the functioning of the SaaS Product, including correct display of API results and attribution compliance.

11.4. **Indemnification.** The Developer agrees to indemnify the Provider against any damages, expenses, and third-party claims arising from:
- the Developer's breach of the terms of this Agreement;
- unlawful or improper use of the API;
- claims by SaaS Product End Users against the Provider.

## 12. Suspension and Termination of Access

12.1. **Automatic Suspension.** API access is automatically suspended when:
- the balance reaches zero;
- Rate Limits are exceeded (temporary, until counter reset).

12.2. **Suspension by Provider.** The Provider has the right to suspend API access with 5 business days' prior notice in the event of:
- the Developer's violation of permitted use (Section 4);
- violation of attribution requirements (Section 5);
- reasonable suspicion of fraudulent or malicious activity.

12.3. **Immediate Termination.** The Provider has the right to immediately terminate API access without prior notice in the event of:
- a threat to the security or stability of the Platform;
- the Developer's violation of the prohibition on creating Competing Products;
- breach of confidentiality or data protection obligations;
- use of the API for unlawful purposes;
- use of the API Key outside the scope of access defined in clauses 4.6–4.7 (other endpoints, non-permitted tools, a Revoked Key, transfer of the key to third parties).

12.4. **Agreement Termination.** Each Party has the right to terminate the Agreement by giving the other Party 30 (thirty) calendar days' written notice. The remaining balance is returned to the Developer within 15 business days after termination, minus the cost of API Requests already used, except in the cases provided for in clause 12.6.

12.5. **Consequences of Termination.** After termination of the Agreement:
- the Developer's API Keys are deactivated;
- the Developer must cease using the Provider's attribution and logos within 30 days;
- API Request logs are retained for 90 days, after which they are deleted;
- obligations regarding confidentiality and intellectual property remain in effect.

12.6. **Consequences of Breaching the Scope of Access.** If the API Key is used in breach of clauses 4.6–4.7, the Provider has the right to:
- immediately and without prior notice deactivate the relevant API Key or all of the Developer's API Keys;
- terminate the Agreement unilaterally as of the moment a notice is sent to the Developer's email address;
- retain the unused prepaid balance of the Developer's account as a contractual penalty for breach of the Agreement under Articles 549 and 551 of the Civil Code of Ukraine and Article 230 of the Commercial Code of Ukraine. In that case the remaining balance is not refunded, not transferred to other accounts and not credited against future payments, and clause 12.4 does not apply insofar as it concerns refunds.

Retention of the balance does not release the Developer from compensating the Provider's losses exceeding that balance. Access may be restored after such a breach only by a separate written decision of the Provider.

## 13. Force Majeure

13.1. The Parties are released from liability for failure to perform obligations if such failure is a consequence of force majeure: natural disasters, military actions, blockades, sanctions, decisions of state authorities, large-scale cyberattacks, pandemics, large-scale failures of cloud providers (AWS, GCP, Azure).

13.2. A Party invoking force majeure is obligated to notify the other Party within 5 business days and provide confirmation from the Chamber of Commerce and Industry of Ukraine or another competent authority.

13.3. If force majeure continues for more than 90 days, each Party has the right to terminate the Agreement with 15 days' notice.

## 14. Dispute Resolution

14.1. All disputes shall be resolved through negotiations.

14.2. If a dispute cannot be resolved through negotiations within 30 days, it shall be submitted to the commercial court at the Provider's location in accordance with the laws of Ukraine.

14.3. This Agreement is governed by and interpreted in accordance with the laws of Ukraine.

## 15. Notices

15.1. **Legally significant notices** (termination of the Agreement, claims, security incidents) shall be sent by email to the addresses specified during registration or through electronic document management systems with a qualified electronic signature.

15.2. **Technical notices** (rate changes, scheduled maintenance, API updates) shall be sent through the personal dashboard, email, or webhook notifications.

15.3. Notices sent by email are deemed received on the next business day after sending.

## 16. Final Provisions

16.1. This Agreement is drawn up in accordance with Articles 633, 634, 641, 642, 901-907, 1107-1114 of the Civil Code of Ukraine and Articles 179-188 of the Commercial Code of Ukraine.

16.2. The Provider has the right to amend this Agreement with 30 days' notice. Continued use of the API after changes take effect constitutes acceptance.

16.3. If any provision of this Agreement is found invalid, this does not affect the validity of other provisions.

16.4. The following are integral parts of this Agreement:
- API Pricing published on the Platform;
- API Technical Documentation;
- Platform Terms of Use;
- Privacy Policy;
- Data Processing Agreement (DPA).

16.5. By entering into this Agreement, the Developer confirms that they have read and agree to all documents specified in clause 16.4.
