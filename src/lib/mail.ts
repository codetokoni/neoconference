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

/** The address mail is sent from, without its display name. */
export function mailFromAddress(): string {
  const from = defaultFrom();
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "mail_not_configured" };
  const body: Record<string, unknown> = {
    from: input.from || defaultFrom(),
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
  };
  if (input.bcc && input.bcc.length > 0) body.bcc = input.bcc;
  if (input.html) body.html = input.html;
  if (input.text) body.text = input.text;
  if (input.replyTo) body.reply_to = input.replyTo;
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
