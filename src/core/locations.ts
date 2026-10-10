// Service-area gazetteer. Source: docs/source/services.md ("Service area").
//
// Zones:
//  - documented:  named explicitly in services.md → PASS
//  - known_city:  well-known localities inside Pune city / PCMC limits that services.md
//                 covers as "adjoining areas" → PASS (lower confidence, noted for staff)
//  - fringe:      peri-urban / PMRDA areas where coverage is not documented → REVIEW
//  - excluded:    named in services.md as not served → FAIL
//  - other_city:  clearly a different city → FAIL
//  - broad:       "Pune" or "near Pune" with no locality → UNKNOWN (ask for the locality)

export type LocationZone = "documented" | "known_city" | "fringe" | "excluded" | "other_city" | "broad";

export interface LocationEntry {
  canonical: string;
  zone: LocationZone;
  area?: "Pune city" | "PCMC";
  aliases?: string[];
}

const E = (canonical: string, zone: LocationZone, area?: LocationEntry["area"], aliases: string[] = []): LocationEntry => ({
  canonical,
  zone,
  area,
  aliases,
});

export const GAZETTEER: LocationEntry[] = [
  // Documented — Pune city
  E("Kothrud", "documented", "Pune city", ["dahanukar colony", "karve nagar", "karvenagar"]),
  E("Baner", "documented", "Pune city", ["baner road"]),
  E("Aundh", "documented", "Pune city", ["sunderban"]),
  E("Wakad", "documented", "Pune city"),
  E("Koregaon Park", "documented", "Pune city", ["koregaon", "kp"]),
  E("Kalyani Nagar", "documented", "Pune city", ["kalyaninagar"]),
  E("Viman Nagar", "documented", "Pune city", ["vimannagar"]),
  E("Hadapsar", "documented", "Pune city", ["amanora"]),
  E("Magarpatta", "documented", "Pune city", ["magarpatta city", "cybercity", "cyber city"]),
  E("NIBM", "documented", "Pune city", ["nibm road"]),
  E("Kondhwa", "documented", "Pune city"),
  E("Undri", "documented", "Pune city"),
  E("Shivane", "documented", "Pune city"),
  E("Warje", "documented", "Pune city", ["warje malwadi"]),
  E("Erandwane", "documented", "Pune city"),
  E("Deccan", "documented", "Pune city", ["deccan gymkhana"]),
  // Documented — PCMC
  E("Pimpri", "documented", "PCMC"),
  E("Chinchwad", "documented", "PCMC"),
  E("Pimple Saudagar", "documented", "PCMC", ["saudagar"]),
  E("Pimple Nilakh", "documented", "PCMC"),
  E("Ravet", "documented", "PCMC"),
  E("Hinjewadi", "documented", "PCMC", ["hinjawadi", "hinjewadi phase 1", "hinjewadi phase 2", "hinjewadi phase 3"]),
  E("PCMC", "documented", "PCMC", ["pimpri chinchwad", "pimpri-chinchwad"]),

  // Known localities within Pune city / PCMC limits ("adjoining areas")
  ...[
    "Kharadi", "Shivajinagar", "Camp", "Bavdhan", "Pashan", "Balewadi", "Sus", "Model Colony", "Prabhat Road",
    "Sadashiv Peth", "Narayan Peth", "Shaniwar Peth", "Kasba Peth", "Swargate", "Bibwewadi", "Katraj", "Dhankawadi",
    "Sinhagad Road", "Dhayari", "Nanded City", "Ambegaon", "Yerawada", "Vishrantwadi", "Dhanori", "Wadgaon Sheri",
    "Mundhwa", "Keshav Nagar", "Fatima Nagar", "Wanowrie", "Salunke Vihar", "Mohammed Wadi", "Yewalewadi",
    "Bhosale Nagar", "Senapati Bapat Road", "FC Road", "JM Road", "Law College Road", "Boat Club Road",
    "Bund Garden", "Sangamwadi", "Karve Road", "Gokhale Nagar", "Ganeshkhind", "Baner Pashan Link Road",
    "Kalyani Nagar Annexe", "Lohegaon", "Manjri", "Kale Padal", "Handewadi", "Pisoli", "Kothrud Depot",
  ].map((n) => E(n, "known_city", "Pune city")),
  ...[
    "Akurdi", "Nigdi", "Bhosari", "Moshi", "Chikhali", "Punawale", "Tathawade", "Thergaon", "Kasarwadi", "Dapodi",
    "Sangvi", "Pimple Gurav", "Kalewadi", "Rahatani", "Pradhikaran", "Kiwale", "Dighi", "Charholi", "Bopkhel",
    "Pimple Saudagar Annexe", "Nigdi Pradhikaran", "Walhekarwadi", "Mamurdi",
  ].map((n) => E(n, "known_city", "PCMC")),

  // Fringe — coverage not documented, human review
  ...[
    "Wagholi", "Chakan", "Pirangut", "Maan", "Marunji", "Mahalunge", "Bhugaon", "Khadakwasla", "Kirkatwadi",
    "Uruli Kanchan", "Loni Kalbhor", "Saswad", "Talawade", "Dehu Road", "Dehu", "Lavale", "Nere", "Jambhe",
    "Kesnand", "Narhe", "Ambegaon Budruk", "Sinhagad",
  ].map((n) => E(n, "fringe")),

  // Explicitly not served (services.md)
  E("Talegaon", "excluded", undefined, ["talegaon dabhade"]),
  E("Lonavala", "excluded", undefined, ["lonavla"]),
  E("Nashik", "excluded", undefined, ["nasik"]),
  E("Mumbai", "excluded", undefined, ["bombay"]),

  // Other cities
  ...[
    "Thane", "Navi Mumbai", "Panvel", "Satara", "Nagpur", "Aurangabad", "Chhatrapati Sambhajinagar", "Kolhapur",
    "Solapur", "Ahmednagar", "Sangli", "Baramati", "Khopoli", "Karjat", "Alibaug", "Bangalore", "Bengaluru",
    "Hyderabad", "Delhi", "New Delhi", "Gurgaon", "Gurugram", "Noida", "Goa", "Chennai", "Kolkata", "Ahmedabad",
    "Surat", "Indore", "Jaipur", "Mahabaleshwar", "Ratnagiri", "Jalgaon", "Latur", "Nanded", "Amravati", "Akola",
  ].map((n) => E(n, "other_city")),

  // Broad region only
  E("Pune", "broad", undefined, ["pune city", "puna"]),
];

export interface LocationMatch {
  entry: LocationEntry;
  alias: string;
  index: number;
}

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

interface IndexedAlias {
  alias: string;
  needle: string;
  entry: LocationEntry;
}

const INDEX: IndexedAlias[] = GAZETTEER.flatMap((entry) =>
  [entry.canonical, ...(entry.aliases ?? [])].map((alias) => ({ alias, needle: norm(alias), entry })),
).sort((a, b) => b.needle.length - a.needle.length); // longest first so "Nanded City" beats "Nanded"

/** Finds all gazetteer places mentioned in text. Longer names win over contained shorter names. */
export function findLocations(text: string): LocationMatch[] {
  const hay = norm(text);
  const taken: Array<[number, number]> = [];
  const found: LocationMatch[] = [];
  for (const item of INDEX) {
    // "KP" alias only matches as a standalone token; skip ultra-short aliases in long sentences.
    if (item.needle.trim().length <= 2 && hay.trim().split(" ").length > 3) continue;
    let from = 0;
    while (true) {
      const idx = hay.indexOf(item.needle, from);
      if (idx === -1) break;
      const end = idx + item.needle.length;
      const overlaps = taken.some(([s, e]) => idx < e && end > s);
      if (!overlaps) {
        taken.push([idx, end]);
        found.push({ entry: item.entry, alias: item.alias, index: idx });
      }
      from = end - 1;
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

export function lookupLocality(name: string): LocationEntry | undefined {
  const n = norm(name);
  return INDEX.find((i) => i.needle === n)?.entry;
}

export const SERVICE_AREA_SUMMARY = "Pune city and PCMC";
