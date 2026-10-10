// Pricing policy enforcement.
//
// The approved response is fixed by the business. Internal pricing material is NOT part of
// this repository and is never placed in any LLM prompt. Every outbound utterance passes
// through `guardOutbound`, which blocks anything that looks like a price, range, rate,
// estimate or discount and substitutes the approved response.

export const APPROVED_PRICING_RESPONSE =
  "Pricing depends on the site, the materials you choose, and the scope. Your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

const PRICING_QUESTION_PATTERNS: RegExp[] = [
  /\bhow much\b/i,
  /\bball ?park\b/i,
  /\bprice list\b/i,
  /\brate card\b/i,
  /\bper\s*(sq\.?\s*f(ee)?t|square\s*f(oo|ee)t|sqft|sft)\b/i,
  /\b(your|the) (rates?|charges|fees|pricing|prices?)\b/i,
  /\bwhat (do|would|will|does) (you|it|that|this) (charge|cost)\b/i,
  /\bwhat('s| is| would be| will be) the (cost|price|rate|charge|fee)\b/i,
  /\b(rough|approximate|approx|indicative|ballpark) (range|figure|number|estimate|idea|cost|price|amount)\b/i,
  /\b(give|tell|send|share) (me |us )?(a |an |the |your )?(range|number|estimate|quote|quotation|figure|price|cost|pricing|rates?)\b/i,
  /\bquote me\b/i,
  /\b(starting|minimum) (price|rate|cost|fee)\b/i,
  /\bwhere do (your|the) (prices|rates) start\b/i,
  /\b(cost|price|pricing|charges?|fees?|rates?)\s*\?\s*$/i,
  /\bhow expensive\b/i,
  /\bany (discount|offer)s?\b/i,
  /\b(cost|price) (of|for) (a|an|the|my|our|doing)\b/i,
  /\bwhat (kind of|sort of)? ?(budget|money) (would|will|do) (i|we) need\b/i,
  /\bkitna (kharcha|lagega|paisa|cost)\b/i,
];

export function isPricingQuestion(text: string): boolean {
  return PRICING_QUESTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Patterns that must never appear in anything said to a caller.
 * Deliberately broad: a false positive only costs a substituted approved response.
 */
const FORBIDDEN_OUTBOUND: Array<{ code: string; re: RegExp }> = [
  { code: "currency_symbol", re: /[₹$€£]\s*\d/ },
  { code: "rupees_word", re: /\b(rs\.?|inr|rupees?)\s*\d/i },
  { code: "amount_unit", re: /\d[\d,.]*\s*(lakh|lakhs|lac|lacs|crore|crores|cr|k)\b/i },
  { code: "amount_unit_words", re: /\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|fifty|hundred)[\s-]+(lakh|lakhs|lac|crore|thousand)\b/i },
  { code: "per_sqft", re: /\bper\s*(sq\.?\s*f(ee)?t|square\s*f(oo|ee)t|sqft|sft)\b/i },
  { code: "rate_phrase", re: /\b(rates?|prices?|pricing|costs?|charges?) (start|starts|starting|begin|begins|range|ranges|from|around|between|of about|is about|is roughly)\b/i },
  { code: "typical_cost", re: /\b(typically|usually|generally|roughly|approximately|around|about) (costs?|runs?|comes? to)\b/i },
  { code: "it_will_cost", re: /\b(it'?ll|it will|that would|this would|it would|would) cost\b/i },
  { code: "discount", re: /\b(\d+\s*%|percent) (off|discount)\b|\bdiscount of\b/i },
  { code: "budget_suggestion", re: /\byou('ll| will| would)? need (a budget|at least|around|about)\b/i },
];

export interface GuardResult {
  text: string;
  blocked: boolean;
  violations: string[];
}

/** Final backend control on every caller-facing utterance. */
export function guardOutbound(text: string): GuardResult {
  if (text === APPROVED_PRICING_RESPONSE) return { text, blocked: false, violations: [] };
  const violations = FORBIDDEN_OUTBOUND.filter((p) => p.re.test(text)).map((p) => p.code);
  if (violations.length === 0) return { text, blocked: false, violations };
  return { text: APPROVED_PRICING_RESPONSE, blocked: true, violations };
}
