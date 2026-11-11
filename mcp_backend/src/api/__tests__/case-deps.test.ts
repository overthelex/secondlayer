import { ModelSelector } from '@secondlayer/shared';
import { buildCaseToolsetDeps, buildChatRequest } from '../private-tools/case-deps.js';

describe('buildCaseToolsetDeps', () => {
  it('turns "No text detected" into an empty OCR result and keeps other failures', async () => {
    const deps = buildCaseToolsetDeps({
      documentParser: {
        parseImage: async (_b, m) => {
          if (m === 'blank') throw new Error('No text detected in image via OCR');
          if (m === 'down') throw new Error('quota');
          return { text: 'ок' };
        },
      },
      legislationService: { getMultipleArticles: async () => [] },
    });
    expect(await deps.ocr(Buffer.alloc(1), 'blank')).toBe('');
    expect(await deps.ocr(Buffer.alloc(1), 'image/jpeg')).toBe('ок');
    await expect(deps.ocr(Buffer.alloc(1), 'down')).rejects.toThrow('quota');
  });
});

describe('buildChatRequest', () => {
  it('pins the OpenAI provider and leaves room for reasoning tokens', () => {
    const req = buildChatRequest({ tier: 'deep', system: 's', user: 'u', json: true });
    expect(req.model).toBe(ModelSelector.getModelSelection('deep', 'openai').model);
    expect(req.max_completion_tokens).toBeGreaterThanOrEqual(16000);
    expect(req.response_format).toEqual({ type: 'json_object' });
    const withImage = buildChatRequest({ tier: 'quick', system: 's', user: 'u', json: false, imageJpeg: Buffer.from('x') });
    expect(Array.isArray(withImage.messages[1].content)).toBe(true);
  });
});
