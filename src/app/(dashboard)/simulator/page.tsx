import { Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/server/auth/session";
import { config } from "@/server/env";
import { Simulator } from "./simulator";

export const dynamic = "force-dynamic";
export const metadata = { title: "Call simulator" };

export default async function SimulatorPage() {
  await requireUser("simulator:use");
  const cfg = config();
  return (
    <>
      <PageHeader
        title="Call simulator"
        description="Type as the caller. Each turn runs through the same conversation engine, qualification rules, persistence and workflows as a live VaaniVoice call."
      />
      <div className="mb-4">
        <Notice>
          Simulated calls are stored and labelled <b>Simulated</b>. They are excluded from live metrics by default, and their notification emails are never sent to real inboxes
          {cfg.anthropic.apiKey ? ". Because an Anthropic key is configured, simulated turns also use the live AI extractor." : "."}
        </Notice>
      </div>
      <Simulator />
    </>
  );
}
