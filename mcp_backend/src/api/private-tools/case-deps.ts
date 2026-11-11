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

/**
 * GPT-5-family models spend reasoning tokens out of max_completion_tokens; a deep call over
 * ten articles plus a 60k-character document needs real headroom or `content` comes back empty.
 */
const MAX_COMPLETION_TOKENS = 16_000;

/** The chat.completions request for a call: always the OpenAI provider, whatever LLM_PROVIDER_STRATEGY says. */
export function buildChatRequest(call: LlmCall): {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: any }>;
  response_format?: { type: 'json_object' };
  max_completion_tokens: number;
} {
  const userContent: any = call.imageJpeg
    ? [
        { type: 'text', text: call.user },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${call.imageJpeg.toString('base64')}`, detail: 'high' } },
      ]
    : call.user;
  return {
    model: ModelSelector.getModelSelection(call.tier, 'openai').model,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: userContent },
    ],
    ...(call.json ? { response_format: { type: 'json_object' as const } } : {}),
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  };
}

/** One chat completion, optionally with the page image, on the tier's OpenAI model. */
export async function callOpenAIVision(call: LlmCall): Promise<string> {
  const req = buildChatRequest(call);
  const res: any = await getOpenAIManager().executeWithRetry((client) => client.chat.completions.create(req as any));
  const choice = res?.choices?.[0];
  const content: string = choice?.message?.content ?? '';
  logger.info('[Cases] LLM call', {
    tier: call.tier,
    model: res?.model ?? req.model,
    finishReason: choice?.finish_reason,
    promptTokens: res?.usage?.prompt_tokens,
    completionTokens: res?.usage?.completion_tokens,
  });
  if (!content || choice?.finish_reason === 'length') {
    logger.warn('[Cases] LLM answer empty or cut off', { tier: call.tier, finishReason: choice?.finish_reason, chars: content.length });
  }
  return content;
}
