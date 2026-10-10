import "server-only";

// Scheduling abstraction. No calendar integration is configured in this release, so the
// default provider stores requests as "pending_confirmation" and reports that availability
// checks are not supported. A real calendar adapter (e.g. Cal.com, which VaaniVoice lists as
// an integration) can implement this interface later without touching business logic.

export interface SchedulingProvider {
  readonly name: string;
  readonly live: boolean;
  supportsAvailability: boolean;
  /** Real providers return available slots; the manual provider never invents any. */
  availability(): Promise<{ supported: false } | { supported: true; slots: string[] }>;
  requestBooking(input: { leadRef: string; preferredText?: string }): Promise<{ status: "pending_confirmation"; detail: string } | { status: "confirmed"; reference: string }>;
}

export class ManualSchedulingProvider implements SchedulingProvider {
  readonly name = "manual";
  readonly live = false;
  supportsAvailability = false;
  async availability() {
    return { supported: false as const };
  }
  async requestBooking() {
    return { status: "pending_confirmation" as const, detail: "No calendar integration — a team member must confirm the slot with the client." };
  }
}

export function getSchedulingProvider(): SchedulingProvider {
  return new ManualSchedulingProvider();
}
