import { Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/session";
import { config } from "@/server/env";
import { Talk } from "./talk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Talk to the receptionist" };

export default async function TalkPage() {
  await requireUser("simulator:use");
  const cfg = config();
  return (
    <>
      <PageHeader
        title="Talk to the AI receptionist"
        description="A real voice conversation with the VaaniVoice agent, in your browser — no phone number needed. When you hang up, the call is pulled from VaaniVoice and qualified by the same rules as phone calls."
      />
      <div className="mb-4">
        <Notice tone="blue">
          The live conversation is run by VaaniVoice’s own language model, following the Aangan script. Qualification, pricing checks and handoffs are applied by this
          system after the call (from the transcript). Test calls are labelled <b>Simulated</b>, use VaaniVoice credits, and never email real inboxes.
        </Notice>
      </div>
      <Talk configured={!!(cfg.vaani.apiKey && cfg.vaani.agentId)} />
    </>
  );
}
