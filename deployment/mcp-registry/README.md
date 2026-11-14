# MCP Registry listing

`server.json` is the listing of the legal.org.ua MCP server in the official MCP Registry
(registry.modelcontextprotocol.io) as `ua.org.legal/lex`. Directories such as PulseMCP pick
servers up from there.

The `ua.org.legal/*` namespace is proven by DNS: the TXT record `v=MCPv1; k=ed25519; p=…`
on legal.org.ua (Cloudflare, comment "MCP Registry namespace") holds the public half of the
Ed25519 key in `~/.mcp-registry/key.pem` on cthulhu. Do not delete that record.

To publish a new version (bump `version` first):

```bash
scp deployment/mcp-registry/server.json local:~/.mcp-registry/server.json
ssh local 'cd ~/.mcp-registry && ~/bin/mcp-publisher login dns --domain legal.org.ua \
  --private-key "$(openssl pkey -in key.pem -outform DER | tail -c 32 | xxd -p -c 64)" \
  && ~/bin/mcp-publisher publish server.json'
```
