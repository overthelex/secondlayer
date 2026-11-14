/**
 * Consent-page helpers for the OAuth authorization endpoint.
 *
 * Dynamic Client Registration (RFC 7591) is open on purpose: the MCP authorization
 * spec expects clients such as Claude and ChatGPT to register themselves. The cost is
 * that client_name is chosen by whoever registered the client, so the consent page
 * must not rely on it. It shows the host the authorization code will be sent to and
 * warns when that host is not one of the MCP clients we know.
 */

/** Hosts of MCP clients we know. A redirect to one of these, or a subdomain, is not flagged. */
const KNOWN_CLIENT_HOSTS = [
  'claude.ai',
  'claude.com',
  'anthropic.com',
  'chatgpt.com',
  'openai.com',
  'legal.org.ua',
  'lawrider.uk',
  'lawrider.ch',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface RedirectTarget {
  /** Host the authorization code goes to, as shown to the user. */
  host: string;
  /** True for loopback redirects (desktop and CLI clients such as Claude Code). */
  local: boolean;
  /** True when the host is neither loopback nor a known MCP client. */
  unverified: boolean;
}

export function describeRedirectTarget(redirectUri: string): RedirectTarget {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return { host: redirectUri, local: false, unverified: true };
  }
  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname)) {
    return { host: url.host, local: true, unverified: false };
  }
  const known = KNOWN_CLIENT_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  return { host: url.host, local: false, unverified: !known };
}

/** Only S256 is accepted. `plain` sends the verifier in the clear and gives no protection. */
export function isSupportedPkceMethod(method: unknown): boolean {
  return method === undefined || method === null || method === '' || method === 'S256';
}
