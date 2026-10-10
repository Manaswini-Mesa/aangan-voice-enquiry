// Caller-facing wording. Kept in one place so tone is consistent and every line is reviewable.
// No line here contains, or may ever contain, a price, range, rate or estimate.

import type { CriterionId } from "../types";
import type { QuestionKey } from "../extraction/rules-extractor";

export const GREETING =
  "Hello, thank you for calling Aangan Studio. I'm the studio's virtual assistant — I can take down your project details and arrange for one of our designers to get in touch. How can I help you today?";

export const RECORDING_NOTICE = " This call may be recorded for quality and training.";

export const QUESTIONS: Record<QuestionKey, string> = {
  intent: "Are you calling about a new interior project, or about a project we're already working on with you?",
  scope: "What would you like to get done — is it a full home, a few rooms, or an office space?",
  engagement: "And would you like us to handle both the design and the execution, or are you mainly looking for design advice?",
  location: "Where is the property located — which area or locality?",
  location_in_area: "Just so I note it correctly — is that within Pune city or the Pimpri-Chinchwad area?",
  location_choice: "Just to confirm, which area is the site itself in?",
  structural: "Will the work involve any structural changes, such as removing or moving walls?",
  area: "Roughly how big is the space, in square feet?",
  timeline: "When would you ideally like the project to be complete?",
  timeline_specific: "Is there a particular date you'd need it finished by?",
  site_ready: "Is the site available for work now, or when will you have access to it?",
  authority: "And will you be the one making the decisions on the project, or are you enquiring on someone else's behalf?",
  authority_followup: "That's helpful, thank you. Have they asked you to go ahead and arrange things for them, or would they prefer to speak with us themselves?",
  name: "May I have your name, please?",
  phone: "And what's the best number for our team to reach you on?",
  consultation_offer: "Would you like me to request a consultation with one of our designers?",
  consultation_time: "What day and time would suit you best? I'll pass your preference to the team so they can confirm it with you.",
  complaint_name: "I'm really sorry to hear that. May I have your name, please?",
  complaint_project: "Thank you. Which project is this about — could you tell me the area of the property and your designer's name, if you have it?",
  complaint_issue: "Could you tell me briefly what's happened, so the senior team has the full picture?",
  existing_message: "Of course. What would you like me to pass on to your project team?",
  confirm_value: "Sorry, could you confirm that for me?",
  anything_else: "Is there anything else I can help you with?",
};

/** Re-asks are phrased differently so the caller doesn't hear the same sentence twice. */
export const REASK: Partial<Record<QuestionKey, string>> = {
  location: "Sorry, I didn't quite catch the area — which locality is the property in?",
  timeline: "Sorry, could you tell me roughly when you'd want the project finished?",
  scope: "Could you tell me a little about which spaces you'd like designed?",
  engagement: "Just to check — would our team be doing the execution as well as the design?",
  name: "Sorry, could I have your name once more?",
  area: "Approximately how many square feet is it?",
  consultation_time: "Which day or time of day generally works for you?",
};

export const LINES = {
  silence: "Sorry, I didn't catch that. Are you still there?",
  silenceEnd:
    "I'm having trouble hearing you, so I'll end the call here. I've saved what you've told me so far, and our team will try to reach you. Thank you for calling Aangan Studio.",
  injection:
    "I'm only able to help with interior design enquiries for Aangan Studio, so I can't help with that.",
  internalDocs:
    "I'm not able to share internal documents, but your designer will go through everything with you at the consultation.",
  humanCallback:
    "I'm not able to transfer the call right now, but I'll note that you'd like to speak with a member of our team, and they'll call you back.",
  humanCallbackContinue: " In the meantime, may I note a few details so they're prepared?",
  pricingRepeatPrefix: "I completely understand wanting a sense of numbers. ",
  bookingAck: "Lovely, I'll request that for you.",
  budgetNoted:
    "Thank you for sharing that. I'll note your budget for the team — they'll check how it fits the scope you've described before anything is booked.",
  closingGeneric: "Thank you for calling Aangan Studio. Have a lovely day!",
  existingDone:
    "Thank you. I've noted your message for your project team, and someone from the team will get back to you.",
} as const;

export function complaintClosing(name?: string): string {
  return `Thank you${name ? `, ${name}` : ""}, and I'm sorry for the trouble. I've logged this as an urgent escalation for our senior team, separate from new enquiries, and a senior member of the team will call you back on this number. Is there anything else you'd like me to add?`;
}

export function qualifiedClosing(name: string | undefined, preference: string | undefined): string {
  const who = name ? `, ${name}` : "";
  if (preference) {
    return `Thank you${who}. I've noted "${preference}" as your preferred time. Please note this isn't confirmed yet — our team will check the designer's availability and confirm the consultation with you. Is there anything else I can help with?`;
  }
  return `Thank you${who}. I've noted all your details, and our team will be in touch to arrange a consultation with a designer. Is there anything else I can help with?`;
}

export function reviewClosing(name?: string): string {
  return `Thank you${name ? `, ${name}` : ""} — that's really helpful. I've noted everything, and a senior member of our team will review the details and get back to you. Is there anything else I can help with?`;
}

export function incompleteClosing(name?: string): string {
  return `No problem${name ? `, ${name}` : ""}. I've saved what we have so far, and our team will follow up with you for the remaining details. Thank you for calling Aangan Studio.`;
}

export const DECLINE_TWO_OR_MORE =
  "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.";

/** Honest, polite explanation for a single failed criterion. Never offers alternatives we can't commit to. */
export function singleFailureClose(id: CriterionId, ruleCode: string): string {
  if (id === "LOCATION") {
    return "Thank you for thinking of us. At the moment we only take on projects in Pune city and the Pimpri-Chinchwad area, because our execution depends on our own contractors and vendors being on site. I'm sorry we can't help with this one. Is there anything else I can help with?";
  }
  if (id === "TIMELINE") {
    return "I want to be honest with you — our design phase alone takes three to four weeks, and execution follows after that, so we couldn't do justice to the project in that time. If your timeline becomes more flexible, we'd be very happy to hear from you again. Is there anything else I can help with?";
  }
  if (id === "COMMERCIAL_SIZE") {
    return "Thank you for explaining. Our commercial team is set up for larger spaces, so this one isn't something we could do well at the quality we'd want to promise. Is there anything else I can help with?";
  }
  if (ruleCode === "SCOPE.STRUCTURAL") {
    return "Thank you for explaining. We're interior designers rather than architects, so we don't take on structural work like moving or removing walls. If you'd like interiors without structural changes, we'd be glad to help. Is there anything else I can help with?";
  }
  if (ruleCode === "SCOPE.UNSUPPORTED_COMMERCIAL_TYPE") {
    return "Thank you so much for reaching out. Restaurants, hotels, retail spaces and gyms are outside our current scope — we focus on homes and offices. I'm sorry we can't help with this one. Is there anything else I can help with?";
  }
  return "Thank you for explaining. We're a full-service studio, so our projects always include both design and execution — at minimum a complete room. If you decide to go ahead with a full redesign, we'd love to hear from you. Is there anything else I can help with?";
}

const ACKS: Record<string, (v: string) => string> = {
  locality: (v) => `${v} — lovely.`,
  full_home: () => "A full home redesign — wonderful.",
  full_floor: () => "Thank you, that's helpful.",
  multi_room: () => "That sounds like a lovely project.",
  single_room: () => "A complete room redesign — that works well for us.",
};

export function acknowledgement(kind: keyof typeof ACKS, value = ""): string {
  return ACKS[kind](value);
}
