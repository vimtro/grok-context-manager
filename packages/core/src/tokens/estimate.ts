/**
 * Local token estimation. Never calls an LLM, never contacts a network service.
 *
 * Grok's production tokenizer is not public, so every number here is an ESTIMATE of text size.
 * - `heuristic`: ~4 characters per token for Latin text, ~1 token per CJK character. Fast, dependency-free.
 * - `o200k`: OpenAI's open o200k_base BPE (via gpt-tokenizer) as a closer *reference* approximation.
 *   It is not Grok's tokenizer; results are labelled accordingly.
 */
import type { TokenEstimate } from '../schemas';

/**
 * The o200k BPE tables take ~0.5 s to parse, so they are loaded lazily (only when the setting or a flag asks for
 * o200k). Until loaded, `effectiveMethod('o200k')` answers 'heuristic' so every number stays correctly labelled.
 */
let o200kCount: ((text: string) => number) | null = null;
let o200kLoading: Promise<void> | null = null;

export function loadTokenizer(method: TokenMethod): Promise<void> {
  if (method !== 'o200k' || o200kCount) return Promise.resolve();
  o200kLoading ??= import('gpt-tokenizer/encoding/o200k_base').then((m) => {
    o200kCount = m.countTokens;
  });
  return o200kLoading;
}

/** The method that will actually be used right now (starts loading o200k in the background if requested). */
export function effectiveMethod(requested: TokenMethod): TokenMethod {
  if (requested === 'o200k' && !o200kCount) {
    void loadTokenizer('o200k').catch(() => undefined);
    return 'heuristic';
  }
  return requested;
}

export type TokenMethod = 'heuristic' | 'o200k';

export interface TokenizerAdapter {
  id: TokenMethod;
  label: string;
  count(text: string): number;
}

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;

export const heuristicTokenizer: TokenizerAdapter = {
  id: 'heuristic',
  label: 'Character heuristic (~4 chars/token; CJK ≈ 1 char/token)',
  count(text: string): number {
    if (!text) return 0;
    const cjk = text.match(CJK)?.length ?? 0;
    const rest = text.length - cjk;
    return cjk + Math.ceil(rest / 4);
  },
};

export const o200kTokenizer: TokenizerAdapter = {
  id: 'o200k',
  label: 'o200k_base BPE reference tokenizer (not Grok’s tokenizer)',
  count(text: string): number {
    if (!text) return 0;
    if (!o200kCount)
      throw new Error('o200k tokenizer not loaded; call loadTokenizer("o200k") first.');
    return o200kCount(text);
  },
};

const ADAPTERS: Record<TokenMethod, TokenizerAdapter> = {
  heuristic: heuristicTokenizer,
  o200k: o200kTokenizer,
};

/** Returns the adapter for `method`, or the heuristic while o200k is still loading. */
export function getTokenizer(method: TokenMethod = 'heuristic'): TokenizerAdapter {
  return ADAPTERS[effectiveMethod(method)];
}

export function estimateTokens(text: string, method: TokenMethod = 'heuristic'): TokenEstimate {
  const adapter = getTokenizer(method);
  return { tokens: adapter.count(text), method: adapter.id, kind: 'estimated' };
}

export function countTokens(text: string, method: TokenMethod = 'heuristic'): number {
  return getTokenizer(method).count(text);
}

/** Percentage reduction of `after` relative to `before`, rounded to one decimal; null when undefined. */
export function reductionPercent(before: number, after: number): number | null {
  if (before <= 0) return null;
  return Math.round(((before - after) / before) * 1000) / 10;
}
