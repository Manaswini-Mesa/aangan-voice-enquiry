import { Notice } from "./ui";

/** Shows the result of the last server action (?ok= / ?err=). */
export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const ok = typeof sp.ok === "string" ? sp.ok : undefined;
  const err = typeof sp.err === "string" ? sp.err : undefined;
  if (!ok && !err) return null;
  return (
    <div className="mb-4" role="status">
      <Notice tone={err ? "red" : "green"}>{err ?? ok}</Notice>
    </div>
  );
}
