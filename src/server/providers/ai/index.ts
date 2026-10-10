import "server-only";
import { config } from "../../env";
import { AnthropicProvider } from "./anthropic";
import type { AiProvider } from "./types";

/** Simulator: no model calls. Facts come from the deterministic extractor; summaries are deterministic. */
export class SimulatedAiProvider implements AiProvider {
  readonly name = "simulated";
  readonly live = false;
  async extractFacts() {
    return { facts: {} };
  }
  async summarize(input: { structuredRecap: string }) {
    return { summary: input.structuredRecap };
  }
  async verify() {
    return { ok: true, detail: "Simulated — no AI calls are made." };
  }
}

let override: AiProvider | undefined;
export function setAiProviderForTests(p: AiProvider | undefined) {
  override = p;
}

export function getAiProvider(): AiProvider {
  if (override) return override;
  const cfg = config();
  if (cfg.anthropic.apiKey) return new AnthropicProvider(cfg.anthropic.apiKey, cfg.anthropic.model, cfg.anthropic.timeoutMs);
  return new SimulatedAiProvider();
}

/**
 * List prices (USD per million tokens) used ONLY to label cost estimates when
 * AI_INPUT_USD_PER_MTOK / AI_OUTPUT_USD_PER_MTOK are not set. Source: Anthropic model
 * table as of 2026-09-25. Estimates are always labelled as estimates in the dashboard.
 */
export const LIST_PRICE_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5-1": { input: 10, output: 50 },
};

export function estimateAiCostUsd(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const cfg = config().anthropic;
  const rates =
    cfg.inputUsdPerMTok !== undefined && cfg.outputUsdPerMTok !== undefined
      ? { input: cfg.inputUsdPerMTok, output: cfg.outputUsdPerMTok }
      : LIST_PRICE_USD_PER_MTOK[model];
  if (!rates) return undefined;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}
