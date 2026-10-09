// src/lib/comms/templates.ts
//
// The transactional email template store. Defaults live in
// templateDefaults.ts (the wording from before templates existed); an edit
// made in Admin → Email templates is stored here and wins until reverted.
//
//   neo:comms:tpl:<id>        JSON  the edited version in use (absent = default)
//   neo:comms:tpl:<id>:hist   list  every saved version, newest first (capped)
//   neo:comms:tpl:<id>:seq    counter  version numbers
//
// Reverting saves a new version with the old content (or deletes the edit
// to return to the default), so history only grows and every change is in
// the admin audit log with before and after.

import { kv } from "@/lib/kv";
import { sendMail, type SendMailInput, type SendMailResult } from "@/lib/mail";
import { renderTemplate, templateBalanced, templateNames, type TemplateVars } from "@/lib/comms/format";
import { TEMPLATE_DEFS, templateDef, type TemplateDef, type TemplateParts } from "@/lib/comms/templateDefaults";
import { logEmail } from "@/lib/comms/log";

const curKey = (id: string) => `neo:comms:tpl:${id}`;
const histKey = (id: string) => `neo:comms:tpl:${id}:hist`;
const seqKey = (id: string) => `neo:comms:tpl:${id}:seq`;
const HISTORY_CAP = 100;

export interface TemplateVersion extends TemplateParts {
  /** 0 is the built-in default. */
  version: number;
  savedAt: number;
  savedBy: string;
  savedByEmail: string;
  note?: string;
  /** Set when this version restored an earlier one. */
  revertedFrom?: number;
}

export interface TemplateState {
  def: TemplateDef;
  current: TemplateVersion | null;
  /** What goes out now: the edit, else the default. */
  active: TemplateParts & { version: number };
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

function partsOf(p: TemplateParts): TemplateParts {
  return { subject: p.subject, html: p.html, text: p.text, ...(p.short !== undefined ? { short: p.short } : {}) };
}

export async function getTemplate(id: string): Promise<TemplateState | null> {
  const def = templateDef(id);
  if (!def) return null;
  let current: TemplateVersion | null = null;
  try {
    current = parse<TemplateVersion>(await kv.get(curKey(id)));
  } catch (err) {
    // KV down: the default still goes out rather than nothing.
    console.warn("[comms/templates] read failed, using the default", id, err);
  }
  const active = current ? { ...partsOf(current), version: current.version } : { ...def.defaults, version: 0 };
  return { def, current, active };
}

export async function listTemplates(): Promise<TemplateState[]> {
  const out: TemplateState[] = [];
  for (const def of TEMPLATE_DEFS) out.push((await getTemplate(def.id))!);
  return out;
}

export async function templateHistory(id: string): Promise<TemplateVersion[]> {
  const raw = ((await kv.lrange(histKey(id), 0, HISTORY_CAP - 1)) ?? []) as unknown[];
  return raw.map((r) => parse<TemplateVersion>(r)).filter((v): v is TemplateVersion => !!v);
}

/** Problems with an edit, or [] when it can be saved. */
export function checkParts(def: TemplateDef, p: TemplateParts): string[] {
  const problems: string[] = [];
  if (!p.subject.trim()) problems.push("The subject cannot be empty.");
  if (!p.text.trim() && !p.html.trim()) problems.push("Write a plain-text body, an HTML body, or both.");
  if (p.subject.length > 300) problems.push("The subject is longer than 300 characters.");
  if (p.html.length > 50_000 || p.text.length > 20_000) problems.push("The body is too long.");
  const allowed = new Set(def.variables.map((v) => v.name));
  for (const [field, src] of Object.entries({ subject: p.subject, html: p.html, text: p.text, short: p.short ?? "" })) {
    if (!templateBalanced(src)) problems.push(`The ${field} opens a {{#section}} it does not close (or closes one in the wrong order).`);
    const unknown = templateNames(src).filter((n) => !allowed.has(n));
    if (unknown.length) problems.push(`The ${field} uses ${unknown.map((n) => `{{${n}}}`).join(", ")}, which this template does not have.`);
  }
  if (/<\s*script\b|\son\w+\s*=|javascript:/i.test(p.html)) problems.push("Scripts and event handlers are not allowed in email HTML.");
  return problems;
}

export function cleanParts(input: Record<string, unknown>, def: TemplateDef): TemplateParts {
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").slice(0, max) : "");
  return {
    subject: s(input.subject, 300).replace(/\n/g, " "),
    html: s(input.html, 50_000),
    text: s(input.text, 20_000),
    ...(def.defaults.short !== undefined ? { short: s(input.short, 500).replace(/\n/g, " ") } : {}),
  };
}

async function writeVersion(id: string, parts: TemplateParts, actor: { userId: string; email: string }, extra: Partial<TemplateVersion>): Promise<TemplateVersion> {
  const version = Number(await kv.incr(seqKey(id)));
  const v: TemplateVersion = { ...partsOf(parts), version, savedAt: Date.now(), savedBy: actor.userId, savedByEmail: actor.email, ...extra };
  await kv.set(curKey(id), JSON.stringify(v));
  await kv.lpush(histKey(id), JSON.stringify(v));
  await kv.ltrim(histKey(id), 0, HISTORY_CAP - 1);
  return v;
}

export async function saveTemplate(
  id: string,
  parts: TemplateParts,
  actor: { userId: string; email: string },
  note?: string,
): Promise<{ before: TemplateParts & { version: number }; after: TemplateVersion }> {
  const state = await getTemplate(id);
  if (!state) throw new Error("unknown template");
  const after = await writeVersion(id, parts, actor, note ? { note } : {});
  return { before: state.active, after };
}

/** Back to a saved version (as a new version), or to the default. */
export async function revertTemplate(
  id: string,
  to: number,
  actor: { userId: string; email: string },
): Promise<{ before: TemplateParts & { version: number }; after: TemplateParts & { version: number } } | null> {
  const state = await getTemplate(id);
  if (!state) return null;
  if (to === 0) {
    await kv.del(curKey(id));
    return { before: state.active, after: { ...state.def.defaults, version: 0 } };
  }
  const old = (await templateHistory(id)).find((v) => v.version === to);
  if (!old) return null;
  const after = await writeVersion(id, partsOf(old), actor, { revertedFrom: to });
  return { before: state.active, after };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  short: string;
  version: number;
}

export function renderParts(parts: TemplateParts, vars: TemplateVars): Omit<RenderedEmail, "version"> {
  return {
    subject: renderTemplate(parts.subject, vars, "text"),
    html: parts.html ? renderTemplate(parts.html, vars, "html") : "",
    text: renderTemplate(parts.text, vars, "text"),
    short: parts.short ? renderTemplate(parts.short, vars, "text") : "",
  };
}

/** A template filled in with `vars`, as it would go out now. */
export async function renderEmail(id: string, vars: TemplateVars): Promise<RenderedEmail> {
  const state = await getTemplate(id);
  if (!state) throw new Error(`unknown email template ${id}`);
  return { ...renderParts(state.active, vars), version: state.active.version };
}

/**
 * Render and send a transactional email, and log it for Admin →
 * Communication → Delivery. Transactional mail ignores notification
 * preferences on purpose: it is about the person's own account or meetings.
 */
export async function sendTemplateEmail(
  id: string,
  vars: TemplateVars,
  mail: Omit<SendMailInput, "subject" | "html" | "text">,
  opts: { source?: "template" | "test"; subjectPrefix?: string } = {},
): Promise<SendMailResult & { rendered: RenderedEmail }> {
  const rendered = await renderEmail(id, vars);
  const subject = (opts.subjectPrefix ?? "") + rendered.subject;
  const res = await sendMail({
    ...mail,
    subject,
    ...(rendered.html ? { html: rendered.html } : {}),
    ...(rendered.text ? { text: rendered.text } : {}),
  });
  const count = (mail.bcc?.length ?? 0) || (Array.isArray(mail.to) ? mail.to.length : 1);
  await logEmail({
    source: opts.source ?? "template",
    template: id,
    templateVersion: rendered.version,
    to: mail.bcc?.length ? `${mail.bcc.length} recipient${mail.bcc.length === 1 ? "" : "s"} (bcc)` : Array.isArray(mail.to) ? mail.to.join(", ") : mail.to,
    recipients: count,
    subject,
    status: res.ok ? "sent" : res.error === "mail_not_configured" ? "skipped" : "failed",
    ...(res.ok ? { resendId: res.id } : { error: res.error }),
  });
  return { ...res, rendered };
}
