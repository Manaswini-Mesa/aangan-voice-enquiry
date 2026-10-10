import type { DesignerBrief } from "@/core/summary";

// Email bodies. Concise, professional, minimal personal data: contact details only where the
// recipient needs them to act; full transcripts stay behind dashboard authentication.

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, rows: Array<[string, string | undefined]>, extraHtml = "", link?: string, demo = false): string {
  const tr = rows
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#78716c;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#1c1917">${esc(v)}</td></tr>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px">
<div style="background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:24px">
${demo ? '<p style="background:#fef3c7;color:#92400e;padding:8px 12px;border-radius:6px;font-size:13px;margin:0 0 16px">DEMO / SIMULATED DATA — not a real enquiry</p>' : ""}
<p style="margin:0;color:#b45309;font-size:12px;letter-spacing:.08em;text-transform:uppercase">Aangan Studio · Enquiries</p>
<h1 style="font-size:20px;margin:6px 0 16px;color:#1c1917">${esc(title)}</h1>
<table style="border-collapse:collapse;font-size:14px;width:100%">${tr}</table>
${extraHtml}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="background:#1c1917;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">Open in dashboard</a></p>` : '<p style="margin:20px 0 0;color:#78716c;font-size:13px">Open the Aangan dashboard to see the full record (APP_BASE_URL is not configured, so no link is included).</p>'}
</div></div></body></html>`;
}

function textBlock(title: string, rows: Array<[string, string | undefined]>, extra: string, link?: string, demo = false): string {
  return [
    demo ? "[DEMO / SIMULATED DATA]" : "",
    title,
    "",
    ...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    extra ? `\n${extra}` : "",
    link ? `\nDashboard: ${link}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export function handoffEmail(b: DesignerBrief, link: string | undefined, demo: boolean): Rendered {
  const rows: Array<[string, string | undefined]> = [
    ["Lead", b.leadRef],
    ["Caller", b.caller.name ?? "Name not given"],
    ["Phone", b.caller.phone],
    ["Email", b.caller.email],
    ["Project", [b.project.category, b.project.type?.replace(/_/g, " ")].filter(Boolean).join(" · ")],
    ["Location", b.project.locality],
    ["Scope", b.project.scope],
    ["Execution", b.project.execution],
    ["Area", b.project.area ? `${b.project.area} sq ft` : undefined],
    ["Timeline", b.timeline],
    ["Budget", b.budget],
    ["Authority", b.authority],
    ["Consultation", b.consultationPreference ? `Prefers "${b.consultationPreference}" — NOT confirmed` : "No time given"],
    ["Next action", b.nextAction],
  ];
  const crit = b.qualification.map((q) => `<li><b>${esc(q.state)}</b> — ${esc(q.criterion)}: ${esc(q.reason)}</li>`).join("");
  const extraHtml = `
<h2 style="font-size:15px;margin:20px 0 8px">Summary</h2><p style="font-size:14px;line-height:1.5;margin:0">${esc(b.summary)}</p>
<h2 style="font-size:15px;margin:20px 0 8px">Qualification (rules ${esc(b.ruleVersion)})</h2><ul style="font-size:13px;line-height:1.5;padding-left:18px;margin:0">${crit}</ul>
${b.outstandingQuestions.length ? `<h2 style="font-size:15px;margin:20px 0 8px">Still to ask</h2><ul style="font-size:13px;padding-left:18px;margin:0">${b.outstandingQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
${b.flags.length ? `<h2 style="font-size:15px;margin:20px 0 8px">Notes &amp; uncertainty</h2><ul style="font-size:13px;padding-left:18px;margin:0">${b.flags.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}`;
  const extraText = [
    `Summary: ${b.summary}`,
    "Qualification:",
    ...b.qualification.map((q) => `- ${q.state} — ${q.criterion}: ${q.reason}`),
    b.outstandingQuestions.length ? `Still to ask: ${b.outstandingQuestions.join("; ")}` : "",
    b.flags.length ? `Notes: ${b.flags.join(" | ")}` : "",
  ].join("\n");
  const subject = `${demo ? "[DEMO] " : ""}Qualified lead ${b.leadRef}: ${b.project.scope ?? "interior project"}${b.project.locality ? ` in ${b.project.locality}` : ""}`;
  return { subject: subject.slice(0, 200), html: layout(`New qualified lead — ${b.leadRef}`, rows, extraHtml, link, demo), text: textBlock(subject, rows, extraText, link, demo) };
}

export function reviewEmail(
  leadRef: string,
  callerName: string | undefined,
  locality: string | undefined,
  reasons: string[],
  link: string | undefined,
  demo: boolean,
): Rendered {
  const rows: Array<[string, string | undefined]> = [
    ["Lead", leadRef],
    ["Caller", callerName ?? "Name not given"],
    ["Location", locality],
  ];
  const extraHtml = `<h2 style="font-size:15px;margin:20px 0 8px">Why it needs a person</h2><ul style="font-size:13px;padding-left:18px;margin:0">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  const subject = `${demo ? "[DEMO] " : ""}Review needed: ${leadRef}`;
  return { subject, html: layout(`Enquiry needs human review — ${leadRef}`, rows, extraHtml, link, demo), text: textBlock(subject, rows, `Reasons:\n- ${reasons.join("\n- ")}`, link, demo) };
}

export function complaintEmail(
  leadRef: string,
  info: { name?: string; phone?: string; designer?: string; project?: string; summary: string },
  link: string | undefined,
  demo: boolean,
): Rendered {
  const rows: Array<[string, string | undefined]> = [
    ["Reference", leadRef],
    ["Client", info.name ?? "Name not given"],
    ["Callback number", info.phone],
    ["Designer named", info.designer],
    ["Project", info.project],
    ["Requested", "Callback from a senior team member"],
  ];
  const extraHtml = `<h2 style="font-size:15px;margin:20px 0 8px">What the client said</h2><p style="font-size:14px;line-height:1.5;margin:0">${esc(info.summary.slice(0, 800))}</p>`;
  const subject = `${demo ? "[DEMO] " : ""}URGENT — existing client complaint ${leadRef}`;
  return { subject, html: layout("Existing client complaint — please call back", rows, extraHtml, link, demo), text: textBlock(subject, rows, `Client said: ${info.summary.slice(0, 800)}`, link, demo) };
}

export function existingClientEmail(leadRef: string, info: { name?: string; phone?: string; designer?: string; message: string }, link: string | undefined, demo: boolean): Rendered {
  const rows: Array<[string, string | undefined]> = [
    ["Reference", leadRef],
    ["Client", info.name ?? "Name not given"],
    ["Phone", info.phone],
    ["Designer named", info.designer],
  ];
  const subject = `${demo ? "[DEMO] " : ""}Message from existing client ${leadRef}`;
  const extraHtml = `<p style="font-size:14px;line-height:1.5;margin:16px 0 0">${esc(info.message.slice(0, 800))}</p>`;
  return { subject, html: layout("Existing client message", rows, extraHtml, link, demo), text: textBlock(subject, rows, info.message.slice(0, 800), link, demo) };
}

export function overdueEmail(items: Array<{ ref: string; kind: string; due: string }>, link: string | undefined): Rendered {
  const rows: Array<[string, string | undefined]> = items.slice(0, 30).map((i) => [i.ref, `${i.kind} — due ${i.due}`]);
  const subject = `Aangan: ${items.length} overdue follow-up(s)`;
  return { subject, html: layout("Overdue follow-ups", rows, "", link), text: textBlock(subject, rows, "", link) };
}
