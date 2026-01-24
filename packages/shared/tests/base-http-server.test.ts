import request from 'supertest';
import { BaseHTTPServer } from '../src/http/base-http-server';

class TestServer extends BaseHTTPServer {
  constructor() {
    super({
      serviceName: 'test-service',
      version: '0.0.0',
      enableCostTracking: false,
    });
  }

  async initialize(): Promise<void> {
  }

  getApp() {
    return this.app;
  }
}

describe('BaseHTTPServer', () => {
  test('GET /health returns status ok with service and version', async () => {
    const server = new TestServer();

    const res = await request(server.getApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('test-service');
    expect(res.body.version).toBe('0.0.0');
  });

  test('unknown route returns 404 json', async () => {
    const server = new TestServer();

    const res = await request(server.getApp()).get('/nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
