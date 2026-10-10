import type { QuestionKey } from "@/core/extraction/rules-extractor";
import type { EnquiryFacts } from "@/core/types";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ExtractInput {
  utterance: string;
  lastQuestion: QuestionKey | null;
  /** Short plain-language recap of what is already known (never pricing material). */
  knownSummary: string;
  now: Date;
}

export interface SummaryInput {
  transcript: Array<{ speaker: "caller" | "agent" | "system"; text: string }>;
  structuredRecap: string;
}

export interface AiProvider {
  readonly name: string;
  /** True only for a real model API. The simulator returns false. */
  readonly live: boolean;
  extractFacts(input: ExtractInput, opts?: { timeoutMs?: number }): Promise<{ facts: Partial<EnquiryFacts>; usage?: AiUsage }>;
  summarize(input: SummaryInput, opts?: { timeoutMs?: number }): Promise<{ summary: string; usage?: AiUsage }>;
  /** Lightweight connectivity check used by the integrations page. */
  verify(): Promise<{ ok: boolean; detail: string }>;
}
