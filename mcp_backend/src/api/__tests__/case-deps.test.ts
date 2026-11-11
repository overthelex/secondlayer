import { buildCaseToolsetDeps } from '../private-tools/case-deps.js';

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
