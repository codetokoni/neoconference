// src/lib/mail.ts
//
// Thin Resend wrapper. Activates when RESEND_API_KEY is set in env.
// Exposes isMailConfigured() and sendMail(). Network errors are caught
// and returned as { ok: false, error } so callers can keep flowing.
//
// We deliberately avoid pulling in the resend npm SDK to keep cold-start
// time low - the REST endpoint is trivial.

export type SendMailInput = {
  to: string | string[];
  /** Blind copies: one message to many people who should not see each other. */
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  /** Files to attach, e.g. a calendar invite. Content is the file's text. */
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
};

export type SendMailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export function isMailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

function defaultFrom(): string {
  return process.env.MAIL_FROM || "NeoConference <onboarding@resend.dev>";
}

/**
 * MAIL_FROM's address under the platform name from the admin settings
 * (only when it was changed from the default, so MAIL_FROM's own display
 * name still applies otherwise), and the support email as reply-to.
 */
async function brandedSender(): Promise<{ from: string; replyTo: string | undefined }> {
  try {
    const { getPlatformSettings } = await import("@/lib/platform/settings");
    const { DEFAULT_PLATFORM_NAME, DEFAULT_SUPPORT_EMAIL } = await import("@/lib/platform/model");
    const s = await getPlatformSettings();
    const name = s.branding.platformName.replace(/["<>\r\n]/g, "").trim();
    const from = name && name !== DEFAULT_PLATFORM_NAME ? `${name} <${mailFromAddress()}>` : defaultFrom();
    const support = s.contacts.supportEmail;
    return { from, replyTo: support && support !== DEFAULT_SUPPORT_EMAIL ? support : undefined };
  } catch {
    return { from: defaultFrom(), replyTo: undefined };
  }
}

/** The address mail is sent from, without its display name. */
export function mailFromAddress(): string {
  const from = defaultFrom();
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "mail_not_configured" };
  // The platform name and support address set in /admin/settings: the
  // sender's display name, and where replies go unless the caller says.
  const branding = await brandedSender();
  const body: Record<string, unknown> = {
    from: input.from || branding.from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
  };
  if (input.bcc && input.bcc.length > 0) body.bcc = input.bcc;
  if (input.html) body.html = input.html;
  if (input.text) body.text = input.text;
  if (input.replyTo || branding.replyTo) body.reply_to = input.replyTo || branding.replyTo;
  if (input.headers && Object.keys(input.headers).length > 0) body.headers = input.headers;
  if (input.attachments && input.attachments.length > 0) {
    // Resend takes attachment content base64-encoded.
    body.attachments = input.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content, "utf8").toString("base64"),
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }));
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!r.ok) return { ok: false, error: r.status === 429 ? "rate_limited" : j.message || ("http_" + r.status) };
    return { ok: true, id: j.id || "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    return { ok: false, error: msg };
  }
}

export type SendMailBatchResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * Up to 100 different emails in one request (Resend's batch endpoint): each
 * its own recipient, subject and body. No attachments. With an idempotency
 * key Resend sends a repeated request only once (24 hours).
 */
export async function sendMailBatch(
  items: Array<Omit<SendMailInput, "attachments" | "bcc">>,
  opts: { idempotencyKey?: string } = {}
): Promise<SendMailBatchResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "mail_not_configured" };
  if (items.length === 0) return { ok: true, ids: [] };
  if (items.length > 100) return { ok: false, error: "batch_too_large" };
  const branding = await brandedSender();
  const body = items.map((input) => {
    const one: Record<string, unknown> = {
      from: input.from || branding.from,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
    };
    if (input.html) one.html = input.html;
    if (input.text) one.text = input.text;
    if (input.replyTo || branding.replyTo) one.reply_to = input.replyTo || branding.replyTo;
    if (input.headers && Object.keys(input.headers).length > 0) one.headers = input.headers;
    return one;
  });
  try {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        "authorization": "Bearer " + key,
        "content-type": "application/json",
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; message?: string };
    if (!r.ok) return { ok: false, error: r.status === 429 ? "rate_limited" : j.message || ("http_" + r.status) };
    return { ok: true, ids: (j.data ?? []).map((d) => d.id || "") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown_error" };
  }
}
