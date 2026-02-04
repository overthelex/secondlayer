# Staging MCP Server Setup Guide

This guide explains how to set up HTTPS access to the Staging MCP Server via `stage.mcp.legal.org.ua`.

## Architecture

```
Claude Desktop / External Client
         ↓
stage.mcp.legal.org.ua:443 (HTTPS + SSL)
         ↓
Nginx on gate server (reverse proxy)
         ↓
localhost:3004 (Stage MCP Backend)
```

## Prerequisites

1. Staging MCP backend running on port 3002
2. DNS record for `stage.mcp.legal.org.ua` pointing to gate server IP
3. Nginx installed on gate server
4. Certbot for SSL certificate management

## Installation Steps

### Step 1: Copy Nginx Configuration

```bash
# On gate server
sudo cp deployment/nginx-stage-mcp.conf /etc/nginx/sites-available/stage.mcp.legal.org.ua
sudo ln -s /etc/nginx/sites-available/stage.mcp.legal.org.ua /etc/nginx/sites-enabled/
```

### Step 2: Test Nginx Configuration

```bash
sudo nginx -t
```

If you see "syntax is ok", proceed to next step.

### Step 3: Get SSL Certificate

```bash
# Get Let's Encrypt certificate for the subdomain
sudo certbot --nginx -d stage.mcp.legal.org.ua
```

Follow the prompts. Certbot will:
- Get the SSL certificate
- Automatically update the nginx configuration
- Set up automatic renewal

### Step 4: Reload Nginx

```bash
sudo systemctl reload nginx
```

### Step 5: Verify Installation

Check that the service is accessible:

```bash
# Test health endpoint
curl https://stage.mcp.legal.org.ua/health

# Test MCP discovery
curl -H "Authorization: Bearer test-key-123" \
     https://stage.mcp.legal.org.ua/mcp
```

Or run the comprehensive test script:

```bash
cd deployment
./test-stage-mcp-connection.sh
```

## API Authentication

The staging server uses API key authentication. Valid keys are defined in `.env.stage`:

```
SECONDARY_LAYER_KEYS=local-dev-key,test-key-123
```

Include the key in the Authorization header:

```bash
Authorization: Bearer test-key-123
```

## Endpoints

### Health Check
```
GET https://stage.mcp.legal.org.ua/health
```

No authentication required.

### MCP Discovery
```
GET https://stage.mcp.legal.org.ua/mcp
Authorization: Bearer <api-key>
```

Returns MCP server metadata and available transports.

### SSE Endpoint (Primary)
```
POST https://stage.mcp.legal.org.ua/sse
Authorization: Bearer <api-key>
Content-Type: application/json
Accept: text/event-stream
```

This is the main endpoint for MCP over HTTPS. It accepts JSON-RPC 2.0 messages and returns Server-Sent Events.

### HTTP API Endpoints
```
POST https://stage.mcp.legal.org.ua/api/tools/:toolName
Authorization: Bearer <api-key>
```

Direct HTTP API access to individual tools.

## Claude Desktop Integration

To use this MCP server with Claude Desktop, add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "secondlayer-stage": {
      "url": "https://stage.mcp.legal.org.ua/sse",
      "transport": {
        "type": "sse"
      },
      "headers": {
        "Authorization": "Bearer test-key-123"
      }
    }
  }
}
```

## Testing

### Quick Test

```bash
# Test SSE connection
curl -X POST \
  -H "Authorization: Bearer test-key-123" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  https://stage.mcp.legal.org.ua/sse
```

### Comprehensive Test

```bash
cd deployment
./test-stage-mcp-connection.sh
```

This script tests:
1. Health check
2. MCP discovery
3. SSE connection initialization
4. Tools listing
5. Actual tool execution (classify_intent)

## Troubleshooting

### Connection Refused

Check that staging backend is running:

```bash
docker ps | grep stage
netstat -tlnp | grep 3002
```

### SSL Certificate Issues

Renew certificate manually:

```bash
sudo certbot renew --nginx
```

### CORS Errors

The nginx configuration includes proper CORS headers. If you still see CORS errors:

1. Check that the request includes the `Origin` header
2. Verify that the API key is correct
3. Check nginx error logs: `sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-error.log`

### SSE Connection Drops

- Check nginx timeout settings (already set to 3600s)
- Verify that firewalls allow long-lived connections
- Check that the backend hasn't crashed: `docker logs mcp-stage-app`

## Logs

### Nginx Access Logs
```bash
sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-access.log
```

### Nginx Error Logs
```bash
sudo tail -f /var/log/nginx/stage.mcp.legal.org.ua-error.log
```

### Backend Logs
```bash
docker logs -f mcp-stage-app
```

## Security Notes

1. **API Keys**: Change default API keys in production
2. **SSL**: Certificate auto-renews every 90 days via certbot
3. **CORS**: Configured to allow credentials and common headers
4. **Rate Limiting**: Consider adding nginx rate limiting for production

## Related Documentation

- `GATEWAY_SETUP.md` - Multi-environment gateway setup
- `nginx-gateway-3env.conf` - Internal gateway routing
- `test-stage-mcp-connection.sh` - Connection test script

## Port Reference

| Environment | HTTP Port | PostgreSQL | Redis |
|------------|-----------|------------|-------|
| Local      | 3000      | 5432       | 6379  |
| Dev        | 3003      | 5433       | 6380  |
| **Stage**  | **3004**  | **5434**   | **6381** |
| Prod       | 3001      | 5432       | 6379  |

## Next Steps

After setup:

1. Test the connection using the test script
2. Configure Claude Desktop with the SSE URL
3. Test a few queries to verify functionality
4. Monitor logs for any issues
5. Consider setting up monitoring/alerting for the endpoint
