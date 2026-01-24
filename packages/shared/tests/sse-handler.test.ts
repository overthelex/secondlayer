import { SSEHandler } from '../src/http/sse-handler';

function createMockResponse() {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    end: jest.fn(),
    setHeader: jest.fn(),
  };
}

describe('SSEHandler', () => {
  test('setupHeaders sets required SSE headers', () => {
    const res = createMockResponse();

    SSEHandler.setupHeaders(res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
  });

  test('sendEvent writes event lines and json data', () => {
    const res = createMockResponse();

    SSEHandler.sendEvent(res as any, {
      id: '1',
      type: 'progress',
      data: { a: 1 },
    });

    expect(res.chunks.join('')).toContain('id: 1\n');
    expect(res.chunks.join('')).toContain('event: progress\n');
    expect(res.chunks.join('')).toContain('data: {"a":1}\n\n');
  });

  test('sendEnd ends response', () => {
    const res = createMockResponse();

    SSEHandler.sendEnd(res as any);

    expect(res.end).toHaveBeenCalledTimes(1);
  });
});
