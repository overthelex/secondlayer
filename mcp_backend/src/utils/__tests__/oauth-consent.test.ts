import { describeRedirectTarget, isSupportedPkceMethod } from '../oauth-consent';

describe('describeRedirectTarget', () => {
  it('does not flag Claude or ChatGPT callbacks', () => {
    expect(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback')).toEqual({
      host: 'claude.ai',
      local: false,
      unverified: false,
    });
    expect(describeRedirectTarget('https://chatgpt.com/connector_platform_oauth_redirect').unverified).toBe(false);
  });

  it('treats loopback redirects as local, keeping the port', () => {
    expect(describeRedirectTarget('http://localhost:53682/callback')).toEqual({
      host: 'localhost:53682',
      local: true,
      unverified: false,
    });
    expect(describeRedirectTarget('http://127.0.0.1:8080/cb').local).toBe(true);
  });

  it('flags an unknown host', () => {
    expect(describeRedirectTarget('https://attacker-alpha1.example.com/cb')).toEqual({
      host: 'attacker-alpha1.example.com',
      local: false,
      unverified: true,
    });
  });

  it('does not accept a lookalike that only ends with a known name', () => {
    expect(describeRedirectTarget('https://evilclaude.ai/cb').unverified).toBe(true);
    expect(describeRedirectTarget('https://claude.ai.evil.com/cb').unverified).toBe(true);
  });

  it('flags an unparseable URI', () => {
    expect(describeRedirectTarget('not a url').unverified).toBe(true);
  });
});

describe('isSupportedPkceMethod', () => {
  it('accepts S256 or no method', () => {
    expect(isSupportedPkceMethod('S256')).toBe(true);
    expect(isSupportedPkceMethod(undefined)).toBe(true);
  });

  it('rejects plain and anything else', () => {
    expect(isSupportedPkceMethod('plain')).toBe(false);
    expect(isSupportedPkceMethod('s256')).toBe(false);
  });
});
