// src/lib/comms/format.ts
//
// Text an administrator writes, made safe to send. Pure — the admin screens
// use it for their live preview, and the server renders with the same code,
// so the preview is the message.
//
// Two things live here:
//
//   formatMessage()  a small, safe formatting language for announcement
//                    bodies: paragraphs, line breaks, **bold**, *italic*,
//                    [links](https://…) and "- " bullet lists. Everything
//                    else is text — HTML typed into a body is shown as
//                    characters, never interpreted.
//
//   renderTemplate() {{variables}} for email templates, mustache-style:
//                    {{name}} escaped for HTML (and as-is in subjects and
//                    plain text), {{#flag}}…{{/flag}} shown when the value is
//                    set, {{^flag}}…{{/flag}} when it is not. No raw-HTML
//                    variables: every value is escaped in an HTML body.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/* -------------------------------------------------------------------------- */
/*  Announcement formatting                                                    */
/* -------------------------------------------------------------------------- */

/** Only web links and mail links; anything else (javascript:, data:) stays text. */
export function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^mailto:[^\s<>"]+$/i.test(u)) return u;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

type Inline = { html: string; text: string };

function inline(src: string, origin?: string): Inline {
  let html = "";
  let text = "";
  let i = 0;
  const re = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    html += escapeHtml(src.slice(i, m.index));
    text += src.slice(i, m.index);
    if (m[1] !== undefined) {
      html += `<strong>${escapeHtml(m[1])}</strong>`;
      text += m[1];
    } else if (m[2] !== undefined) {
      html += `<em>${escapeHtml(m[2])}</em>`;
      text += m[2];
    } else {
      const href = safeHref(m[4]);
      const abs = href && href.startsWith("/") && origin ? origin.replace(/\/+$/, "") + href : href;
      if (abs) {
        html += `<a href="${escapeHtml(abs)}" style="color:#0891b2">${escapeHtml(m[3])}</a>`;
        text += `${m[3]} (${abs})`;
      } else {
        html += escapeHtml(m[0]);
        text += m[0];
      }
    }
    i = m.index + m[0].length;
  }
  html += escapeHtml(src.slice(i));
  text += src.slice(i);
  return { html, text };
}

export interface Formatted {
  /** For an email body. */
  html: string;
  /** Plain text: the email's text part. */
  text: string;
  /** One line, no markup: the bell and a push notification. */
  short: string;
}

/**
 * An announcement body to HTML, plain text and a one-line summary.
 * `origin` turns site paths ("/pricing") into full links for email.
 */
export function formatMessage(body: string, origin?: string): Formatted {
  const blocks = body.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).filter((b) => b.trim());
  const html: string[] = [];
  const text: string[] = [];
  const P = 'style="margin:0 0 12px;font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#0f172a"';
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => inline(l.replace(/^\s*[-*]\s+/, ""), origin));
      html.push(`<ul ${P}>${items.map((it) => `<li>${it.html}</li>`).join("")}</ul>`);
      text.push(items.map((it) => `- ${it.text}`).join("\n"));
    } else {
      const parts = lines.map((l) => inline(l, origin));
      html.push(`<p ${P}>${parts.map((p) => p.html).join("<br>")}</p>`);
      text.push(parts.map((p) => p.text).join("\n"));
    }
  }
  const plain = text.join("\n\n");
  const flat = plain.replace(/\s+/g, " ").trim();
  return { html: html.join(""), text: plain, short: flat.length > 240 ? `${flat.slice(0, 239)}…` : flat };
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                  */
/* -------------------------------------------------------------------------- */

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

function truthy(v: TemplateVars[string]): boolean {
  return !(v === undefined || v === null || v === false || v === "" || v === 0);
}

/**
 * Fill a template. `html` escapes every value; subjects and plain text take
 * them as they are. An unknown {{name}} renders as nothing.
 */
export function renderTemplate(src: string, vars: TemplateVars, mode: "html" | "text"): string {
  // Sections first, innermost out, so they can nest.
  const section = /\{\{([#^])\s*([\w.]+)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/;
  let out = src;
  for (let guard = 0; guard < 200; guard++) {
    const m = section.exec(out);
    if (!m) break;
    const on = truthy(vars[m[2]]);
    const keep = m[1] === "#" ? on : !on;
    out = out.slice(0, m.index) + (keep ? m[3] : "") + out.slice(m.index + m[0].length);
  }
  return out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    const s = v === undefined || v === null || v === false ? "" : String(v);
    return mode === "html" ? escapeHtml(s) : s;
  });
}

/** The {{names}} a template mentions, for checking an edit against the variables it may use. */
export function templateNames(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\{\{\s*[#^/]?\s*([\w.]+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

/** Whether every section opened is closed, in order. */
export function templateBalanced(src: string): boolean {
  const stack: string[] = [];
  for (const m of src.matchAll(/\{\{\s*([#^/])\s*([\w.]+)\s*\}\}/g)) {
    if (m[1] === "/") {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]);
  }
  return stack.length === 0;
}
