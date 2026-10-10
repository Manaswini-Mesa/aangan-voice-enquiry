// Deterministic, rule-based fact extraction from a single caller utterance.
// Used in demo mode, as the always-on baseline in live mode, and as the fallback when
// the LLM extractor is unavailable. Output is validated and merged by merge.ts.

import { findLocations, type LocationMatch } from "../locations";
import { isPricingQuestion } from "../pricing/policy";
import {
  monthIndex,
  weeksUntilEndOfMonth,
  weeksUntilFestival,
  weeksUntilStartOfMonth,
} from "../time";
import type {
  Authority,
  EnquiryFacts,
  Engagement,
  Fact,
  PropertyType,
  ScopeSize,
} from "../types";

export type QuestionKey =
  | "intent"
  | "scope"
  | "engagement"
  | "location"
  | "location_in_area"
  | "location_choice"
  | "structural"
  | "area"
  | "timeline"
  | "timeline_specific"
  | "site_ready"
  | "authority"
  | "authority_followup"
  | "name"
  | "phone"
  | "consultation_offer"
  | "consultation_time"
  | "complaint_name"
  | "complaint_project"
  | "complaint_issue"
  | "existing_message"
  | "confirm_value"
  | "anything_else";

export interface Signals {
  pricingQuestion: boolean;
  wantsBooking: boolean;
  declinesBooking: boolean;
  goodbye: boolean;
  promptInjection: boolean;
  humanRequest: boolean;
  correction: boolean;
  affirmative: boolean;
  negative: boolean;
  /** Utterance carried no usable content. */
  empty: boolean;
}

export interface ExtractionContext {
  lastQuestion: QuestionKey | null;
  now: Date;
  turn: number;
  /** STT confidence for the utterance (0..1); defaults to 1 when the provider gives none. */
  sttConfidence?: number;
}

export interface ExtractionResult {
  facts: Partial<EnquiryFacts>;
  signals: Signals;
}

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, couple: 2, "a couple of": 2, few: 3, "a few": 3,
};

function toNumber(word: string): number | undefined {
  const w = word.toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
  return NUM_WORDS[w];
}

const NUM = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|a couple of|a few|couple|few|an?)`;

function fact<T>(value: T, confidence: number, evidence: string, ctx: ExtractionContext, source: Fact<T>["source"] = "caller_stated"): Fact<T> {
  const stt = ctx.sttConfidence ?? 1;
  return {
    value,
    source,
    confidence: Math.round(Math.min(confidence, stt) * 100) / 100,
    evidence: evidence.length > 160 ? `${evidence.slice(0, 157)}...` : evidence,
    turn: ctx.turn,
    validation: stt < 0.6 ? "unverified" : "valid",
  };
}

/** Removes the studio's own name so "Aangan Studio" never reads as a "studio" project. */
function clean(text: string): string {
  return text
    .replace(/aangan\s*studios?/gi, "Aangan")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const AFFIRM = /^(yes|yeah|yep|yup|sure|ok|okay|please|correct|right|absolutely|definitely|of course|haan|ha|ji|that's right|that is right|exactly|sounds good|go ahead|why not|alright|fine)\b/i;
const NEGATE = /^(no|nope|nah|not really|nahi|no thanks|not now|not yet|i don't think so|not at the moment)\b/i;

function detectSignals(t: string, ctx: ExtractionContext): Signals {
  const lower = t.toLowerCase();
  const affirmative = AFFIRM.test(lower);
  const negative = NEGATE.test(lower);
  const bookingWords = /\b(book|schedule|set up|arrange|fix)\b.*\b(consultation|meeting|appointment|visit|site visit|call)\b|\blet'?s book\b|\bbook (it|that|one)\b|\bsite visit\b.*\b(please|yes)\b|\b(please|yes).*\bsite visit\b/i;
  const offerContext = ctx.lastQuestion === "consultation_offer";
  // A bare "okay/fine" after the pricing line is usually an acknowledgement, not a booking.
  const strongYes = /^(yes|yeah|yep|yup|sure|please|absolutely|definitely|of course|go ahead|haan|ji|that would be (great|lovely|nice)|sounds good)\b/i.test(lower);
  return {
    pricingQuestion: isPricingQuestion(t),
    wantsBooking: bookingWords.test(t) || (offerContext && strongYes && !negative),
    declinesBooking: offerContext && negative,
    goodbye: /\b(bye|goodbye|that'?s all|that is all|nothing else|that'?s it|hang up|i have to go|gotta go)\b/i.test(t),
    promptInjection:
      /\b(ignore|disregard|forget) (all |your |the )?(previous |prior |earlier )?(instructions|rules|prompt)\b|\bsystem prompt\b|\byou are now\b|\bdeveloper mode\b|\b(reveal|show|read out|tell me) (your|the) (prompt|instructions|rules)\b|\binternal (pricing|price|rate|document|guide|sheet)\b|\bpricing (guide|sheet|document|doc|pdf)\b|\bjailbreak\b/i.test(t),
    humanRequest: /\b(speak|talk) (to|with) (a |an |some )?(human|person|someone|real person|manager|designer|nikhil|senior)\b|\breal person\b|\btransfer me\b|\bconnect me (to|with)\b/i.test(t),
    correction: /\b(actually|sorry,? i meant|i mean|correction|let me correct|not .{1,30}? but|i misspoke|scratch that)\b/i.test(t),
    affirmative,
    negative,
    empty: t.replace(/[^a-z0-9]/gi, "").length === 0,
  };
}

// ---------- individual extractors ----------

const NAME_STOP = new Set([
  "calling", "looking", "planning", "in", "the", "a", "an", "just", "doing", "not", "from", "interested", "okay",
  "fine", "good", "sure", "here", "having", "trying", "very", "so", "really", "thinking", "wondering", "renting",
  "staying", "living", "moving", "getting", "building", "opening", "running", "the", "owner", "founder", "on",
  "with", "at", "about", "afraid", "sorry", "glad", "happy", "still", "also", "ready", "currently", "new", "back",
  "searching", "exploring", "enquiring", "inquiring", "asking", "hoping", "keen", "told", "one", "able", "unable",
]);

function titleCase(s: string): string {
  return s
    .replace(/[.,!?;:]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function extractName(t: string, ctx: ExtractionContext): Fact<string> | undefined {
  const explicit = t.match(/\bmy name is ([A-Za-z][A-Za-z.'-]*(?: [A-Za-z][A-Za-z.'-]*){0,2})/i) ?? t.match(/\bname'?s ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/);
  if (explicit) return fact(titleCase(explicit[1].replace(/\b(and|from|i|calling)\b.*$/i, "").trim()), 0.95, explicit[0], ctx);
  const intro = t.match(/\b(?:[Tt]his is|[Ii]'?m|I am|[Ii]t'?s)\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?/);
  if (intro && !NAME_STOP.has(intro[1].toLowerCase())) {
    const second = intro[2] && !NAME_STOP.has(intro[2].toLowerCase()) && !findLocations(intro[2]).length ? ` ${intro[2]}` : "";
    const name = `${intro[1]}${second}`;
    if (!findLocations(intro[1]).length) return fact(name, 0.85, intro[0], ctx);
  }
  if (ctx.lastQuestion === "name" || ctx.lastQuestion === "complaint_name") {
    const bare = t.replace(/^(yes|yeah|sure|ok|okay|it'?s|this is|i'?m|i am|my name is|name is|call me)[\s,]+/i, "").replace(/[.!]+$/, "").trim();
    const notAName = /\b(book|yes|no|please|consultation|thanks|thank|sure|okay|ok|fine|later|call|bye|that'?s|that|all|it|what|how|why|when|price|cost)\b/i.test(bare);
    const words = notAName ? [] : bare.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w));
    if (words.length >= 1 && words.length <= 3 && words.length === bare.split(/\s+/).length && !NAME_STOP.has(words[0].toLowerCase())) {
      return fact(titleCase(words.join(" ")), 0.8, t, ctx);
    }
  }
  return undefined;
}

function extractPhone(t: string, ctx: ExtractionContext): Fact<string> | undefined {
  const m = t.replace(/[\s()-]/g, "").match(/(\+?91)?([6-9]\d{9})\b/);
  if (!m) return undefined;
  return fact(`+91${m[2]}`, 0.9, "phone number given", ctx);
}

function extractEmail(t: string, ctx: ExtractionContext): Fact<string> | undefined {
  const m = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? fact(m[0].toLowerCase(), 0.9, "email given", ctx) : undefined;
}

const UNSUPPORTED_COMMERCIAL: Array<[RegExp, PropertyType]> = [
  [/\b(restaurant|dhaba|eatery|food court|cloud kitchen|bar and|pub|lounge bar)\b/i, "restaurant"],
  [/\b(cafe|café|coffee shop|bakery)\b/i, "cafe"],
  [/\b(hotel|resort|guest ?house|homestay|hostel|hospitality|banquet)\b/i, "hotel"],
  [/\b(retail|shop|store|showroom|boutique|outlet|supermarket|mall)\b/i, "retail"],
  [/\b(gym|fitness (centre|center|studio)|crossfit|yoga studio)\b/i, "gym"],
  [/\b(salon|spa|parlour|parlor)\b/i, "salon"],
];

function extractProperty(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  const lower = t.toLowerCase();
  const bhk = lower.match(/\b(\d|one|two|three|four|five|six)\s*-?\s*(bhk|b\.h\.k|bedroom (flat|apartment|home|house))\b/i);
  if (bhk) {
    out.bhk = fact(toNumber(bhk[1]) ?? Number(bhk[1]), 0.95, bhk[0], ctx);
    out.projectCategory = fact("residential", 0.95, bhk[0], ctx);
    out.propertyType = fact("apartment", 0.85, bhk[0], ctx);
  }
  if (/\b(villa|bungalow)\b/i.test(t)) {
    out.projectCategory = fact("residential", 0.95, "villa/bungalow", ctx);
    out.propertyType = fact("villa", 0.9, "villa/bungalow", ctx);
  } else if (/\b(independent house|row ?house|twin bungalow)\b/i.test(t)) {
    out.projectCategory = fact("residential", 0.95, "independent house", ctx);
    out.propertyType = fact("independent_house", 0.9, "independent house", ctx);
  } else if (!out.propertyType && /\b(flat|apartment|my home|our home|my house|our house|penthouse)\b/i.test(t.replace(/\bhome[- ]office\b/gi, ""))) {
    out.projectCategory = fact("residential", 0.85, "flat/apartment/home", ctx);
    out.propertyType = fact("apartment", 0.7, "flat/apartment", ctx);
  }

  for (const [re, type] of UNSUPPORTED_COMMERCIAL) {
    const m = t.match(re);
    if (m) {
      out.projectCategory = fact("commercial", 0.9, m[0], ctx);
      out.propertyType = fact(type, 0.9, m[0], ctx);
      return;
    }
  }
  // "home office" and "study" are rooms in a home, not commercial projects.
  const withoutHomeOffice = lower.replace(/\bhome[- ]office\b/g, "");
  const office = withoutHomeOffice.match(/\b(office|workspace|work space|workstations?|coworking|co-working|pod|clinic|dental|studio space|design studio|photo studio|commercial (space|project|fit ?out)|fit ?out)\b/i);
  if (office) {
    const word = office[0].toLowerCase();
    const type: PropertyType = /clinic|dental/.test(word)
      ? "clinic"
      : /cowork|co-work|pod/.test(word)
        ? "coworking"
        : /studio/.test(word)
          ? "studio"
          : "office";
    if (!out.propertyType || out.projectCategory?.value !== "residential") {
      out.projectCategory = fact("commercial", 0.85, office[0], ctx);
      out.propertyType = fact(type, 0.85, office[0], ctx);
    }
  }
}

const ROOM_PATTERNS: Array<[RegExp, string]> = [
  [/\bkitchen\b/i, "kitchen"],
  [/\b(living ?room|living area|hall|lounge)\b/i, "living room"],
  [/\bdining\b/i, "dining"],
  [/\bmaster bed(room)?\b/i, "master bedroom"],
  [/\b(study|home[- ]office)\b/i, "study / home office"],
  [/\b(bathroom|washroom|toilet)s?\b/i, "bathroom"],
  [/\b(pooja|puja) room\b/i, "pooja room"],
  [/\b(kids'? room|children'?s room|nursery)\b/i, "kids room"],
  [/\bguest room\b/i, "guest room"],
  [/\bbalcony\b/i, "balcony"],
  [/\bfoyer|entrance\b/i, "foyer"],
];

function countBedrooms(t: string): number {
  const m = t.match(new RegExp(`\\b(both|all|${NUM.slice(1, -1)})\\s+(?:the\\s+)?(?:other\\s+)?bed ?rooms\\b`, "i"));
  if (m) {
    const w = m[1].toLowerCase();
    if (w === "both") return 2;
    if (w === "all") return 3;
    return toNumber(w) ?? 2;
  }
  if (/\bbed ?rooms\b/i.test(t)) return 2;
  if (/\b(one |a |the |my |our )?(?<!master )bed ?room\b/i.test(t)) return 1;
  return 0;
}

function extractScope(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  const lower = t.toLowerCase();
  // Engagement: advisory/limited services first (they override generic "redo" words).
  const engagementChecks: Array<[RegExp, Engagement, number]> = [
    [/\b(vastu)\b.*\b(only|just|consult|advice|check)\b|\b(only|just)\b.*\bvastu\b/i, "vastu_only", 0.9],
    [/\b(just|only|mainly)\b.{0,30}\b(ideas|suggestions|advice|advise|opinion|tips)\b|\b(give|share) (us |me )?(some )?(ideas|suggestions|advice)\b|\bcome and (advise|give)\b|\bsecond opinion\b|\bconsultation only\b|\badvice only\b|\b(i'?ll|we'?ll|i will|we will) (do|handle|manage) (the )?execution (myself|ourselves)\b|\bexecution (myself|ourselves)\b|\bnot planning to do the full\b/i, "advice_only", 0.9],
    [/\b(rearrang\w*|furniture arrangement|re-?arrange)\b|\b(only|just)\b.{0,25}\b(colou?rs?|paint colou?rs?|styling|decor|decorat\w*)\b|\bcolou?r (advice|consultation|suggestions)\b/i, "styling_only", 0.85],
    [/\b(just|only)\b.{0,20}\b(source|buy|procure|purchase|shop for)\b.{0,20}\bfurniture\b|\bfurniture (sourcing|procurement|shopping)\b|\b(source|procure) (some )?furniture\b/i, "furniture_sourcing", 0.85],
    [/\b(only|just) (the )?design\b|\bdesign only\b|\bjust (the )?drawings\b|\bwe have (our own|a) contractor\b/i, "design_only", 0.8],
  ];
  const mentionsExecution = /\b(with execution|full execution|execution (too|as well|also)|design and execution|and execution|execute it|you (do|handle) the execution)\b/i.test(t);
  for (const [re, value, conf] of engagementChecks) {
    if (mentionsExecution && value === "design_only") continue;
    const m = t.match(re);
    if (m) {
      out.engagement = fact(value, conf, m[0], ctx);
      break;
    }
  }
  if (!out.engagement) {
    const explicitExec = t.match(/\b(design and execution|design \+ execution|full execution|with execution|execution (too|as well|also)|end[- ]to[- ]end|turnkey|design[, ]+materials,? furniture|all of it|the full package|full package|complete (redesign|package|interiors|fit ?out)|full (redesign|interiors|fit ?out)|fit ?out from scratch)\b/i);
    const impliedExec = t.match(/\b(redo|re-do|redesign|renovat\w*|do up|revamp|makeover|modular kitchen|wardrobes|interiors?|furnish\w*|fit ?out|fitout|done up|design the (whole|entire|full)|properly design|interior design)\b/i);
    if (explicitExec) out.engagement = fact("design_and_execution", 0.95, explicitExec[0], ctx);
    else if (impliedExec) out.engagement = fact("design_and_execution", 0.75, impliedExec[0], ctx);
    else if (ctx.lastQuestion === "engagement") {
      if (/\b(both|execution|everything|full|complete)\b/i.test(t) || AFFIRM.test(lower)) out.engagement = fact("design_and_execution", 0.85, t, ctx);
      else if (/\b(advice|ideas|suggestions|consult)\b/i.test(t)) out.engagement = fact("advice_only", 0.85, t, ctx);
    }
  }

  // Scope size
  let size: ScopeSize | undefined;
  let sizeEvidence = "";
  const fullHome = t.match(/\b(whole|entire|full|complete) (house|flat|home|apartment|villa|place|thing)\b|\bfull[- ]home\b|\b(whole|entire) (\d|one|two|three|four)\s*bhk\b|\bend[- ]to[- ]end (design|interiors)\b|\ball (the )?rooms\b|\bfull package\b|\bpoora ghar\b|\bfull interiors\b|\bdo everything\b|\beverything from scratch\b/i);
  const fullFloor = t.match(/\b(full|entire|whole|complete) (ground |first |second |top |upper )?floor\b(?!ing)/i);
  const residentialProperty = out.projectCategory?.value === "residential";
  const wholeRedesign = residentialProperty
    ? t.match(/\b(full|complete|total|entire) (redesign|interiors?|renovation|makeover|interior design)\b|\bredo the (whole|entire)\b|\bdo the (whole|entire|full)\b|\bproper(ly)? design (the|our|my) (flat|home|house|apartment)\b/i)
    : null;
  if (fullHome) {
    size = "full_home";
    sizeEvidence = fullHome[0];
  } else if (wholeRedesign && !/\b(only|just) (the )?(kitchen|living|bed|master|study|dining)/i.test(t)) {
    size = "full_home";
    sizeEvidence = wholeRedesign[0];
  } else if (fullFloor) {
    size = "full_floor";
    sizeEvidence = fullFloor[0];
  }
  const rooms: string[] = [];
  for (const [re, name] of ROOM_PATTERNS) if (re.test(t)) rooms.push(name);
  const bedrooms = countBedrooms(t.replace(/\bmaster bed(room)?\b/gi, ""));
  for (let i = 0; i < bedrooms; i++) rooms.push("bedroom");
  if (/\bwardrobes?\b/i.test(t) && bedrooms === 0 && !rooms.includes("master bedroom")) {
    // wardrobes imply bedroom work; count as one bedroom space if none named
    rooms.push("bedroom (wardrobes)");
  }
  if (rooms.length) out.rooms = fact(rooms, 0.85, rooms.join(", "), ctx);
  if (!size && rooms.length >= 2) {
    size = "multi_room";
    sizeEvidence = rooms.join(", ");
  } else if (!size && rooms.length === 1) {
    size = "single_room";
    sizeEvidence = rooms[0];
  }
  if (!size && out.projectCategory?.value === "commercial" && /\b(fit ?out|workstations|cabins?|meeting room|reception|bare shell|from scratch)\b/i.test(t)) {
    size = "full_floor";
    sizeEvidence = "commercial fit-out";
  }
  if (!size && out.projectCategory?.value === "commercial" && out.engagement?.value === "design_and_execution") {
    size = "full_floor";
    sizeEvidence = "design and execution for the whole commercial space";
  }
  if (size) out.scopeSize = fact(size, 0.8, sizeEvidence, ctx);

  // Structural work (negations first)
  const noStructural = t.match(/\bno (structural|wall[- ]breaking|civil)\b|\bnot? (break|breaking|remove|removing|move|moving|touch|touching|knock|knocking) (any |the )?walls?\b|\b(don'?t|do not|won'?t|will not) (break|move|remove|touch|knock)\b.{0,15}\bwalls?\b|\bwithout (breaking|any structural|structural)\b|\bno changes to (the )?structure\b|\bnothing structural\b/i);
  const structural = t.match(/\b(break|breaking|remove|removing|knock(ing)? (down|out)|demolish\w*|move|moving|shift|shifting|take out|taking out)\b.{0,20}\bwalls?\b|\bstructural (changes|work|modification|alteration)s?\b|\b(merge|merging|combine|combining)\b.{0,15}\brooms\b|\badd(ing)? (a |an )?(floor|storey|mezzanine|extension)\b|\bextend(ing)? the (balcony|room|terrace)\b|\b(remove|cut|move) (a |the )?(column|beam|slab)\b/i);
  if (noStructural) out.structuralWork = fact("none", 0.9, noStructural[0], ctx);
  else if (structural) out.structuralWork = fact("required", 0.9, structural[0], ctx);
  else if (ctx.lastQuestion === "structural") {
    if (NEGATE.test(lower) || /\bnothing\b|\bnone\b/i.test(t)) out.structuralWork = fact("none", 0.85, t, ctx);
    else if (AFFIRM.test(lower)) out.structuralWork = fact("required", 0.75, t, ctx);
  }

  // Ownership
  const rented = t.match(/\b(rented|rental|renting|on rent|tenant|lease|landlord)\b/i);
  const owned = t.match(/\b(we bought|i bought|bought it|our own|my own (flat|home|house|apartment|place)|i own|we own|purchased|possession|owner|owners)\b/i);
  if (rented) out.ownership = fact("rented", 0.9, rented[0], ctx);
  else if (owned) out.ownership = fact("owned", 0.8, owned[0], ctx);

  // Area
  const area = t.replace(/,(?=\d{3})/g, "").match(/\b(\d{2,6}(?:\.\d+)?)\s*(?:sq\.?\s*f(?:ee)?t\.?|sqft|sft|square\s*f(?:ee|oo)t|sq\s*feet|carpet|sq\b)/i);
  if (area) out.areaSqft = fact(Number(area[1]), 0.9, area[0], ctx);
  else if (ctx.lastQuestion === "area") {
    const n = t.replace(/,(?=\d{3})/g, "").match(/\b(\d{2,6})\b/);
    if (n) out.areaSqft = fact(Number(n[1]), 0.8, t, ctx);
  }
}

function extractLocation(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  const matches = findLocations(t);
  const specific = matches.filter((m) => m.entry.zone !== "broad");
  const pick = (m: LocationMatch, confidence: number, alternatives?: string[]) => {
    out.locality = fact(
      { raw: m.alias, canonical: m.entry.canonical, ...(alternatives?.length ? { alternatives } : {}) },
      confidence,
      m.alias,
      ctx,
    );
  };
  if (specific.length === 1) {
    pick(specific[0], 0.9);
    return;
  }
  if (specific.length > 1) {
    const distinct = [...new Set(specific.map((m) => m.entry.canonical))];
    if (distinct.length === 1) {
      pick(specific[0], 0.9);
      return;
    }
    // Prefer a place introduced as the site/property location.
    const siteRe = /\b(flat|site|property|project|apartment|home|house|office|space|villa|bungalow|clinic|plot)\b[^.?!]{0,40}?\b(in|at|near)\s+$/i;
    const site = specific.find((m) => siteRe.test(t.toLowerCase().slice(0, Math.max(0, m.index - 1)) + " "));
    if (site) {
      pick(site, 0.8, distinct.filter((d) => d !== site.entry.canonical));
      return;
    }
    const last = specific[specific.length - 1];
    pick(last, 0.5, distinct.filter((d) => d !== last.entry.canonical));
    return;
  }
  if (matches.length && matches[0].entry.zone === "broad") {
    if (!out.locality) out.locality = fact({ raw: "Pune" }, 0.9, matches[0].alias, ctx);
    return;
  }
  if (ctx.lastQuestion === "location") {
    // Unrecognised place name answered to a direct location question.
    const raw = t
      .replace(/^(it'?s|it is|in|at|near|the site is in|the flat is in|we are in|we're in|our flat is in|the property is in|yes|yeah|so)\s+/gi, "")
      .replace(/[.!?]+$/, "")
      .trim();
    if (raw && raw.split(/\s+/).length <= 5 && /^[a-z][a-z .'-]*$/i.test(raw)) {
      out.locality = fact({ raw: titleCase(raw) }, 0.7, t, ctx);
    }
  }
  if (ctx.lastQuestion === "location_in_area") {
    if (AFFIRM.test(t.toLowerCase())) out.localityClaimedInArea = fact(true, 0.7, t, ctx);
    else if (NEGATE.test(t.toLowerCase())) out.localityClaimedInArea = fact(false, 0.85, t, ctx);
  }
}

function weeksFromDuration(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("day")) return Math.round((n / 7) * 10) / 10;
  if (u.startsWith("week")) return n;
  if (u.startsWith("month")) return Math.round(n * 4.345 * 10) / 10;
  if (u.startsWith("year")) return n * 52;
  return n;
}

function extractTimeline(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  const lower = t.toLowerCase();
  const isTimelineQ = ctx.lastQuestion === "timeline" || ctx.lastQuestion === "timeline_specific";
  const siteQ = ctx.lastQuestion === "site_ready";

  // Site readiness
  const siteNow = t.match(/\b(already (have|got) (the )?possession|possession (was|came|happened) (last|this)|got possession|have possession|flat is empty|completely empty|bare shell|shell and core|already moved out|moved out temporarily|site is (ready|available|empty)|we can go (now|anytime)|available now|(we|i) live there|been (living )?here|moved in|lived here|we'?ve been here)\b/i);
  const siteLater = t.match(new RegExp(`\\b(possession|handover|keys)\\b[^.?!]{0,30}?\\b(in|after|within)\\s+(?:about\\s+|around\\s+|another\\s+)?${NUM}\\s+(days?|weeks?|months?)\\b`, "i"));
  const siteMonth = t.match(/\b(possession|handover)\b[^.?!]{0,25}?\b(next month|in (january|february|march|april|may|june|july|august|september|october|november|december))\b/i);
  const siteOnDate = t.match(/\b(possession|handover)\b[^.?!]{0,20}?\b(?:is|on|by)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i)
    ?? t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (siteLater) {
    const n = toNumber(siteLater[3]) ?? 1;
    out.siteReadyWeeks = fact(weeksFromDuration(n, siteLater[4]), 0.85, siteLater[0], ctx);
  } else if (siteMonth) {
    const phrase = siteMonth[2].toLowerCase();
    const p = new Date(ctx.now);
    const month = phrase === "next month" ? (new Date(p).getUTCMonth() + 1) % 12 : monthIndex(phrase.replace("in ", ""));
    out.siteReadyWeeks = fact(weeksUntilStartOfMonth(ctx.now, month), 0.75, siteMonth[0], ctx);
  } else if (siteNow) {
    out.siteReadyWeeks = fact(0, 0.85, siteNow[0], ctx);
  } else if (siteQ) {
    if (/\b(now|already|ready|available|anytime|any time|immediately)\b/i.test(t) || AFFIRM.test(lower)) out.siteReadyWeeks = fact(0, 0.8, t, ctx);
    const d = t.match(new RegExp(`\\b${NUM}\\s+(days?|weeks?|months?)\\b`, "i"));
    if (d) out.siteReadyWeeks = fact(weeksFromDuration(toNumber(d[1]) ?? 1, d[2]), 0.8, d[0], ctx);
  }
  if (siteOnDate && /possession|handover/i.test(t) && !siteLater && !siteMonth) {
    const month = monthIndex(siteOnDate[siteOnDate.length - 2]);
    if (month >= 0) out.siteReadyWeeks = fact(weeksUntilStartOfMonth(ctx.now, month), 0.8, siteOnDate[0], ctx);
  }

  // Flexible
  const flexible = t.match(/\b(no rush|no hurry|not in a (rush|hurry)|flexible|no (specific |fixed )?deadline|whenever|plenty of time|take (our|your) time|no particular date|in no rush|not urgent)\b/i);
  if (flexible) out.timelineFlexible = fact(true, 0.9, flexible[0], ctx);

  // Desired start
  const start = t.match(/\b(start|starting|begin|beginning|commence)\w*\b[^.?!]{0,30}?\b(in|from|by|around|after)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\b/i)
    ?? t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december) start\b/i);
  if (start) {
    const monthWord = start[0].match(/january|february|march|april|may|june|july|august|september|october|november|december/i)![0];
    out.desiredStartWeeks = fact(weeksUntilStartOfMonth(ctx.now, monthIndex(monthWord)), 0.8, start[0], ctx);
  }
  if (/\b(start|begin)\w*\b[^.?!]{0,20}\b(right away|immediately|asap|as soon as possible|now|this month)\b/i.test(t)) {
    out.desiredStartWeeks = fact(0, 0.8, "start right away", ctx);
  }

  // Completion deadline
  const completionVerb = /\b(done|ready|complete|completed|finish|finished|move (in|back)|moving (in|back)|operational|before|by|deadline|need it|want it|guests|handover|wrap up|live in)\b/i;
  const relDuration = t.match(new RegExp(`\\b(?:in|within|next|about|around|only|just|maximum|max|of)?\\s*${NUM}\\s+(days?|weeks?|months?)\\b(?!\\s+(ago|back))`, "i"));
  const monthBy = t.match(/\b(by|before|until|till|in|around|end of|for|move in|move back in|operational by|done by|ready by|complete by)\s+(?:the\s+)?(?:end of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(20\d\d|next year))?\b/i);
  const festival = t.match(/\b(before|by|for|until|till)\s+(diwali|christmas|new year|ganpati|holi)\b/i);
  const asap = /\b(asap|as soon as possible|urgent|urgently|immediately|right away)\b/i.test(t) && completionVerb.test(t);
  const isStartPhrase = (s: string) => /\b(start|starting|begin|beginning)\b/i.test(s);

  let completion: Fact<number> | undefined;
  if (festival) {
    const w = weeksUntilFestival(ctx.now, festival[2].toLowerCase());
    if (w !== undefined) completion = fact(w, 0.85, festival[0], ctx);
  }
  if (!completion && monthBy && !isStartPhrase(t.slice(Math.max(0, (monthBy.index ?? 0) - 25), (monthBy.index ?? 0) + monthBy[0].length))) {
    const yearWord = monthBy[3];
    const p = ctx.now.getUTCFullYear();
    const explicitYear = yearWord ? (yearWord === "next year" ? p + 1 : Number(yearWord)) : undefined;
    completion = fact(weeksUntilEndOfMonth(ctx.now, monthIndex(monthBy[2]), explicitYear), 0.85, monthBy[0], ctx);
  }
  if (!completion && relDuration && !siteLater) {
    const window = t.slice(Math.max(0, (relDuration.index ?? 0) - 60), (relDuration.index ?? 0) + relDuration[0].length + 40);
    const n = toNumber(relDuration[1]);
    const isPossession = /\b(possession|handover|keys)\b/i.test(window);
    const isPast = /\b(ago|been|for the (last|past)|since)\b/i.test(window);
    const isStart = /\b(start|starting|begin)\b/i.test(window) && !/\b(done|ready|complete|finish)\b/i.test(window);
    if (n !== undefined && !isPossession && !isPast && !isStart && (completionVerb.test(window) || isTimelineQ)) {
      completion = fact(weeksFromDuration(n, relDuration[2]), isTimelineQ ? 0.85 : 0.8, relDuration[0], ctx);
    }
  }
  if (!completion && isTimelineQ) {
    const bareMonth = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
    if (bareMonth && !isStartPhrase(t)) completion = fact(weeksUntilEndOfMonth(ctx.now, monthIndex(bareMonth[1])), 0.75, bareMonth[0], ctx);
  }
  // Self-correction inside one utterance: "within two months... actually, no fixed deadline".
  if (completion && flexible) {
    const at = t.toLowerCase().indexOf((completion.evidence ?? "").toLowerCase());
    const between = t.slice(Math.max(0, at), flexible.index ?? 0);
    if (at >= 0 && (flexible.index ?? 0) > at && /\b(actually|sorry|i mean|scratch that|no wait)\b/i.test(between)) completion = undefined;
  }
  if (completion) {
    out.completionWeeks = completion;
    out.timelineText = fact(completion.evidence ?? t, completion.confidence, t, ctx);
  } else if (asap && !out.desiredStartWeeks) {
    out.completionAsap = fact(true, 0.8, "needs it as soon as possible", ctx);
    out.timelineText = fact(t, 0.8, t, ctx);
  } else if (flexible || start) {
    out.timelineText = fact(t, 0.8, t, ctx);
  }
}

function parseAmountInr(num: string, unit: string | undefined): number | undefined {
  const n = Number(num.replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const u = (unit ?? "").toLowerCase();
  if (/^(lakh|lakhs|lac|lacs|l)$/.test(u)) return Math.round(n * 100_000);
  if (/^(crore|crores|cr)$/.test(u)) return Math.round(n * 10_000_000);
  if (/^k$/.test(u)) return Math.round(n * 1000);
  return n >= 10_000 ? n : undefined;
}

function extractBudget(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  if (/\b(prefer not to (say|mention|share)|don'?t want to (say|share|disclose)|not sure (yet|about the budget)|will discuss|discuss (it )?(at|in) the consultation|rather not say)\b/i.test(t) && /budget|spend|cost|money/i.test(t + (ctx.lastQuestion ?? ""))) {
    out.budgetDeclined = fact(true, 0.9, "prefers not to share budget", ctx);
    return;
  }
  const budgetContext = /\b(budget|spend|afford|max(imum)?|all[- ]in|upto|up to|total|around|about)\b/i.test(t);
  const range = t.match(/(?:₹|rs\.?|inr|rupees)?\s*(\d+(?:[.,]\d+)?)\s*(lakh|lakhs|lac|lacs|l|crore|cr|k)?\s*(?:to|-|–|or)\s*(?:₹|rs\.?|inr)?\s*(\d+(?:[.,]\d+)?)\s*(lakh|lakhs|lac|lacs|l|crore|cr|k)\b/i);
  const single = t.match(/(?:₹|rs\.?|inr|rupees)\s*(\d[\d,]*(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|crore|cr|k)?|(\d+(?:\.\d+)?)\s*(lakh|lakhs|lac|lacs|crore|crores|cr)\b/i);
  if (!budgetContext && !/[₹]|\brs\b|\blakh|\bcrore/i.test(t)) return;
  let budget: { min?: number; max?: number } | undefined;
  let evidence = "";
  if (range) {
    const unit = range[4];
    const min = parseAmountInr(range[1], range[2] ?? unit);
    const max = parseAmountInr(range[3], unit);
    if (min !== undefined && max !== undefined) {
      budget = { min, max };
      evidence = range[0];
    }
  } else if (single) {
    const amt = single[1] ? parseAmountInr(single[1], single[2]) : parseAmountInr(single[3], single[4]);
    if (amt !== undefined) {
      budget = /\b(max|maximum|upto|up to|at most|not more than)\b/i.test(t) ? { max: amt } : { min: amt, max: amt };
      evidence = single[0];
    }
  }
  if (!budget) return;
  // Avoid misreading area or other numbers: require a currency unit or budget word.
  out.budgetInr = fact(budget, 0.9, evidence.trim(), ctx);
  out.budgetText = fact(evidence.trim(), 0.9, t, ctx);
  const scope = t.match(/\b(for everything|all[- ]in|including furniture|for the (whole|full|entire) (scope|flat|home|house|project)|for the above scope|total|for both rooms|for the kitchen|for one room)\b/i);
  out.budgetScope = fact(scope ? scope[0] : "not specified", scope ? 0.85 : 0.5, t, ctx);
}

function extractAuthority(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  const lower = t.toLowerCase();
  const behalf = t.match(/\bfor my (parents|in-laws|in laws|mother|father|mom|mum|dad|brother|sister|boss|friend|uncle|aunt|grandparents|client|son|daughter|relative)\b|\bmy (parents|in-laws|mother|father|mom|dad)'?s? (flat|home|house|apartment|place)\b|\b(they|parents|in-laws) (have|own|bought)\b/i);
  if (behalf) {
    const who = (behalf[1] ?? behalf[2] ?? behalf[3] ?? "someone else").toLowerCase();
    out.onBehalfOf = fact(who, 0.85, behalf[0], ctx);
  }
  const researching = t.match(/\b(just |only )?(doing |do )?(some |the )?(initial |preliminary )?(research|checking|enquiring|inquiring|asking around|exploring options)\b.{0,30}\b(for|on behalf of)\b|\b(they'?ll|they will|they would|he'?ll|she'?ll) (decide|make the decision|take the decision)\b|\bdecision (is|will be|lies) (with )?(theirs|them|his|hers|with them|with him|with her)\b|\bnot my decision\b|\bi'?ll (tell|ask|check with|inform) (them|him|her|my parents)\b|\bjust (calling|checking) to see if it'?s worth\b/i);
  const authorized = t.match(/\b(asked|authori[sz]ed|told|wants) me to (call|go ahead|book|proceed|handle|arrange|sort)\b|\bcalling on (his|her|their) behalf\b|\bon behalf of (my|our)\b.{0,40}\b(go ahead|authori[sz]ed|asked me)\b|\b(he|she|they)('?s| is| are) (happy|fine|okay|ok) (for me )?to go ahead\b|\b(knows|know) (we'?re|i'?m) calling and (is|are) happy to go ahead\b|\b(said|says) to go ahead\b|\bi have (their|his|her) (go-ahead|approval|authority|permission|consent)\b|\bi'?m (handling|managing|coordinating) (this|it|the project) for\b/i);
  const decisionMaker = t.match(/\b(i'?m|i am) (the )?(owner|founder|co-?founder|decision[- ]?maker|director|ceo|md|managing director|partner|proprietor)\b|\bit'?s my (own )?(flat|home|house|apartment|office|place|villa)\b|\b(i|we) (decide|make the decisions?)\b|\b(we'?re|we are) the owners\b|\bmyself and my (husband|wife|partner|spouse)\b|\bmy (husband|wife|partner|spouse) and (i|me)\b|\b(we|i) (both )?own (it|the flat|the place)\b|\bi'?m the one (deciding|who decides|paying)\b|\bour own (flat|home|house)\b|\bmy own (flat|home|house|apartment)\b/i);
  if (authorized) out.authority = fact<Authority>("authorized_representative", 0.85, authorized[0], ctx);
  else if (researching) out.authority = fact<Authority>("researching_for_others", 0.85, researching[0], ctx);
  else if (decisionMaker && !behalf) out.authority = fact<Authority>("decision_maker", 0.85, decisionMaker[0], ctx);
  else if (ctx.lastQuestion === "authority" && !behalf) {
    if (AFFIRM.test(lower) || /\b(me|myself|i do|i will|i am|i'?m the one|we will|we do|both of us)\b/i.test(t)) out.authority = fact<Authority>("decision_maker", 0.8, t, ctx);
  } else if (ctx.lastQuestion === "authority_followup") {
    if (AFFIRM.test(lower) && !NEGATE.test(lower)) out.authority = fact<Authority>("authorized_representative", 0.75, t, ctx);
    else if (NEGATE.test(lower)) out.authority = fact<Authority>("researching_for_others", 0.85, t, ctx);
  }
}

function extractIntent(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>) {
  const complaint = t.match(/\b(complain\w*|not acceptable|unacceptable|hasn'?t (replied|responded|called)|haven'?t heard back|not (replied|responded)|no response from|very (upset|unhappy|disappointed)|not happy with|escalate|poor (work|quality|service)|delay(ed)? in my project|still not (done|finished|complete))\b/i);
  const existing = t.match(/\bmy (designer|project manager|ongoing project|current project)\b|\b(existing|current) (client|customer|project)\b|\byou(r team)? (are|is) (doing|working on) (my|our)\b|\bproject (has been|is) (going|running|ongoing)\b|\bmy designer is\b/i);
  if (complaint && (existing || /\bmy (project|designer|flat|site)\b/i.test(t))) {
    out.intent = fact("complaint", 0.9, complaint[0], ctx);
    out.complaintSummary = fact(t, 0.9, t, ctx);
  } else if (existing) {
    out.intent = fact("existing_client", 0.85, existing[0], ctx);
  } else if (out.projectCategory || out.scopeSize || out.engagement || out.bhk || /\b(interior|design|redo|redesign|renovat|project|flat|home|office|apartment)\b/i.test(t)) {
    out.intent = fact("new_enquiry", 0.8, "describes a project", ctx);
  }
  const designer = t.match(/\b[Mm]y designer(?: is| was|,)? ([A-Z][a-z]+)\b/);
  if (designer) out.existingDesigner = fact(designer[1], 0.85, designer[0], ctx);
  const referral = t.match(/\b(got your number from|referred by|recommended by|friend of|asked me to call|saw your work on|found you on|via) ([A-Za-z][\w ]{1,40}?)(?=[.,—-]|$| she| he| who)/i);
  if (referral) out.referral = fact(referral[0], 0.8, referral[0], ctx);
}

function extractConsultation(t: string, ctx: ExtractionContext, out: Partial<EnquiryFacts>, signals: Signals) {
  if (signals.wantsBooking) out.consultationRequested = fact(true, 0.9, t, ctx);
  if (signals.declinesBooking) out.consultationDeclined = fact(true, 0.85, t, ctx);
  const timeWords = /\b(mon|tues|wednes|thurs|fri|satur|sun)days?\b|\bweekends?\b|\bweekdays?\b|\b(this|next) week\b|\btomorrow\b|\bday after\b|\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b(morning|afternoon|evening)\b|\bafter \d{1,2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}\b|\b\d{1,2}(st|nd|rd|th)\b/i;
  if (ctx.lastQuestion === "consultation_time" || (signals.wantsBooking && timeWords.test(t))) {
    if (timeWords.test(t) || ctx.lastQuestion === "consultation_time") {
      out.consultationPreference = fact(t.replace(/^(yes|sure|ok|okay)[,.]?\s*/i, ""), 0.85, t, ctx);
      out.consultationRequested = fact(true, 0.9, t, ctx);
    }
  }
}

/** Main entry: extract facts and conversational signals from one caller utterance. */
export function extractFromUtterance(rawText: string, ctx: ExtractionContext): ExtractionResult {
  const t = clean(rawText);
  const signals = detectSignals(t, ctx);
  const facts: Partial<EnquiryFacts> = {};
  if (signals.empty) return { facts, signals };

  const name = extractName(t, ctx);
  if (name) facts.callerName = name;
  const phone = extractPhone(t, ctx);
  if (phone) facts.phone = phone;
  const email = extractEmail(t, ctx);
  if (email) facts.email = email;

  extractProperty(t, ctx, facts);
  extractScope(t, ctx, facts);
  extractLocation(t, ctx, facts);
  extractTimeline(t, ctx, facts);
  extractBudget(t, ctx, facts);
  extractAuthority(t, ctx, facts);
  extractIntent(t, ctx, facts);
  extractConsultation(t, ctx, facts, signals);

  if (ctx.lastQuestion === "complaint_issue" || ctx.lastQuestion === "existing_message") {
    facts.complaintSummary = fact(t, 0.85, t, ctx);
  }
  if (ctx.lastQuestion === "complaint_project" && !facts.existingDesigner) {
    const d = t.match(/\b(?:designer is|designer was|designer'?s name is|with) ([A-Z][a-z]+)\b/);
    if (d) facts.existingDesigner = fact(d[1], 0.8, d[0], ctx);
  }
  return { facts, signals };
}
