/**
 * Production wiring for the cases toolset: Google Vision OCR through DocumentParser,
 * Azure OpenAI (OPENAI_BASE_URL) through the shared client manager, and article texts
 * through LegislationService. Everything the toolset needs that touches the network.
 */
import { getOpenAIManager, ModelSelector } from '@secondlayer/shared';
import { logger } from '../../utils/logger.js';
import type { CaseToolsetDeps, LlmCall } from './case-toolset.js';

export function buildCaseToolsetDeps(p: {
  documentParser: { parseImage(buf: Buffer, mime: string): Promise<{ text: string }> };
  legislationService: CaseToolsetDeps['legislation'];
}): CaseToolsetDeps {
  return {
    ocr: async (buf, mime) => {
      try {
        return (await p.documentParser.parseImage(buf, mime)).text;
      } catch (e: any) {
        if (/No text detected/i.test(String(e?.message))) return '';
        throw e;
      }
    },
    llm: callOpenAIVision,
    legislation: p.legislationService,
  };
}

/** One chat completion, optionally with the page image, on the tier's model. */
export async function callOpenAIVision(call: LlmCall): Promise<string> {
  const model = ModelSelector.getChatModel(call.tier);
  const userContent: any = call.imageJpeg
    ? [
        { type: 'text', text: call.user },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${call.imageJpeg.toString('base64')}`, detail: 'high' } },
      ]
    : call.user;
  const res: any = await getOpenAIManager().executeWithRetry((client) =>
    client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: userContent },
      ],
      ...(call.json ? { response_format: { type: 'json_object' } } : {}),
      max_completion_tokens: 4000,
    })
  );
  logger.info('[Cases] LLM call', {
    tier: call.tier,
    model: res?.model ?? model,
    promptTokens: res?.usage?.prompt_tokens,
    completionTokens: res?.usage?.completion_tokens,
  });
  return res?.choices?.[0]?.message?.content ?? '';
}
