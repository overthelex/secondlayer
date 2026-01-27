# Security Policy

## Supported Versions

We actively support and provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| develop | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of SecondLayer seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**DO NOT** create a public GitHub issue for security vulnerabilities.

Instead, please report security issues by emailing: **security@legal.org.ua**

Alternatively, you can use [GitHub's private vulnerability reporting feature](https://github.com/overthelex/secondlayer/security/advisories/new).

### What to Include

Please include the following information in your report:

- **Description**: Clear description of the vulnerability
- **Impact**: Potential impact and severity
- **Reproduction**: Step-by-step instructions to reproduce the issue
- **Environment**: Affected versions, components, or configurations
- **Proof of Concept**: Code snippets, screenshots, or videos (if applicable)
- **Suggested Fix**: If you have recommendations (optional)

### Response Timeline

We are committed to responding to security reports promptly:

- **Initial Response**: Within 48 hours of report submission
- **Triage**: Within 5 business days we'll assess severity and impact
- **Fix Development**: Timeline depends on severity:
  - Critical: Within 7 days
  - High: Within 14 days
  - Medium: Within 30 days
  - Low: Next scheduled release
- **Public Disclosure**: After fix is deployed and users have time to update (typically 7-14 days)

### Recognition

We appreciate security researchers who help keep SecondLayer secure:

- We will acknowledge your contribution in our security advisories (unless you prefer to remain anonymous)
- For significant vulnerabilities, we may offer a bug bounty (to be determined)

## Security Best Practices

### For Deployment

1. **Environment Variables**
   - Never commit `.env` files or secrets to version control
   - Use strong, unique values for `JWT_SECRET`, `SECONDARY_LAYER_KEYS`
   - Rotate API keys regularly

2. **Database Security**
   - Use strong PostgreSQL passwords (min 16 characters)
   - Restrict database access to application servers only
   - Enable SSL/TLS for database connections in production
   - Regular backups with encryption

3. **API Keys**
   - Protect `OPENAI_API_KEY` and `ZAKONONLINE_API_TOKEN`
   - Use separate keys for dev/stage/prod environments
   - Implement rate limiting and cost controls

4. **Network Security**
   - Use HTTPS/TLS for all external communications
   - Configure firewalls to restrict port access
   - Use VPN or IP whitelisting for sensitive endpoints

5. **Authentication**
   - Implement proper JWT token expiration
   - Use secure OAuth 2.0 flows for user authentication
   - Enable multi-factor authentication for admin accounts

### For Development

1. **Dependencies**
   - Regularly run `npm audit` and fix vulnerabilities
   - Keep dependencies up to date
   - Review security advisories for Node.js and npm packages

2. **Code Review**
   - All PRs require review before merging
   - Pay special attention to authentication and authorization code
   - Validate all user inputs and sanitize outputs

3. **Data Protection**
   - Implement proper access controls for sensitive legal documents
   - Log access to sensitive data for audit purposes
   - Anonymize or pseudonymize data in test environments

4. **MCP Security**
   - Validate all MCP tool inputs
   - Implement rate limiting per client/API key
   - Monitor for suspicious usage patterns

## Scope

This security policy applies to:

- **mcp_backend** - Main MCP server for court cases and legal documents
- **mcp_rada** - Parliament data MCP server
- **lexwebapp** - Web frontend and admin panel
- **deployment** - Docker configurations and infrastructure code
- **packages/shared** - Shared libraries and utilities

## Out of Scope

The following are outside the scope of our security program:

- Vulnerabilities in third-party services (OpenAI, ZakonOnline, Verkhovna Rada API)
- Issues requiring physical access to servers
- Social engineering attacks
- Denial of Service (DoS/DDoS) attacks
- Issues in unsupported versions or custom deployments

## Known Security Considerations

### Data Sensitivity

SecondLayer processes legal documents and court case data that may contain:
- Personal information (names, addresses)
- Confidential legal proceedings
- Attorney-client privileged information

**Recommendations:**
- Implement proper data classification and access controls
- Ensure compliance with GDPR and Ukrainian data protection laws
- Consider encryption at rest for sensitive document storage

### AI/LLM Risks

The system uses AI models (OpenAI GPT-4, embeddings) which may:
- Generate incorrect or hallucinated legal information
- Inadvertently expose training data
- Be subject to prompt injection attacks

**Mitigations:**
- `HallucinationGuard` service validates AI outputs
- `CitationValidator` checks legal citations against sources
- Input sanitization on all MCP tool parameters

### External API Dependencies

The system relies on external APIs:
- ZakonOnline (court case database)
- Verkhovna Rada Open Data (legislation)
- OpenAI API

**Risks:**
- API key compromise could lead to unauthorized access or cost escalation
- External service outages affect system availability
- Data integrity depends on external sources

## Security Features

SecondLayer includes the following security features:

- **Bearer Token Authentication**: API key validation for HTTP endpoints
- **JWT/OAuth Support**: User authentication with signed tokens
- **Cost Tracking**: Monitors API usage to detect anomalies
- **Rate Limiting**: Prevents abuse of expensive operations
- **Input Validation**: Schema validation on all tool parameters
- **Query Intent Classification**: Detects potentially malicious queries
- **Audit Logging**: Tracks all document access and tool executions

## Compliance

We strive to maintain compliance with:

- **GDPR** (General Data Protection Regulation)
- **Ukrainian Data Protection Laws**
- **OpenAI API Terms of Service**
- **Model Context Protocol Security Guidelines**

## Contact

For security inquiries: **security@legal.org.ua**

For general questions: [Create an issue](https://github.com/overthelex/secondlayer/issues)

---

**Last Updated**: January 2026
**Version**: 1.0

## Українська версія

### Звітування про вразливості

Якщо ви виявили вразливість безпеки, будь ласка, повідомте про це відповідально:

- **НЕ** створюйте публічні issue на GitHub
- Надішліть email на: **security@legal.org.ua**
- Або використайте [приватне звітування GitHub](https://github.com/overthelex/secondlayer/security/advisories/new)

### Безпека даних

SecondLayer обробляє юридичні документи та судові рішення, які можуть містити персональні дані. Ми дотримуємося вимог GDPR та українського законодавства про захист персональних даних.

Для питань з безпеки: **security@legal.org.ua**
