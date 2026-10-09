// src/components/help/ArticleBody.tsx
//
// Draws a help article's light markdown as React elements — no HTML from the
// article is ever injected, so an article cannot carry a script. Used by the
// public /help pages and the admin editor's preview.
//
//   ## Heading / ### Subheading     - item / * item     1. step
//   **bold**   `code`   [text](/path or https://…)
//   A blank line starts a new paragraph.

import type { ReactNode } from "react";

type Block =
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

export function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (line.startsWith("### ")) {
      flush();
      out.push({ kind: "h3", text: line.slice(4) });
    } else if (line.startsWith("## ") || line.startsWith("# ")) {
      flush();
      out.push({ kind: "h2", text: line.replace(/^#+\s+/, "") });
    } else if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      const last = out[out.length - 1];
      const item = (ul ?? ol)![1];
      if (last && (last.kind === "ul" || last.kind === "ol") && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else para.push(line);
  }
  flush();
  return out;
}

function safeHref(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (/^https:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  return null;
}

export function inline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${k++}`;
    if (m[1]) out.push(<strong key={key} className="font-semibold text-white">{m[1]}</strong>);
    else if (m[2]) out.push(<code key={key} className="rounded bg-white/10 px-1 py-0.5 text-[0.9em] text-cyan-100">{m[2]}</code>);
    else {
      const href = safeHref(m[4]);
      out.push(
        href ? (
          <a key={key} href={href} className="text-cyan-300 underline-offset-2 hover:underline" {...(href.startsWith("http") ? { rel: "noopener noreferrer" } : {})}>
            {m[3]}
          </a>
        ) : (
          m[3]
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function ArticleBody({ body }: { body: string }) {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed text-cyan-50/85">
      {parseBlocks(body).map((b, i) => {
        if (b.kind === "h2") return <h2 key={i} className="pt-2 text-xl font-semibold text-white">{inline(b.text, `h${i}`)}</h2>;
        if (b.kind === "h3") return <h3 key={i} className="pt-1 text-base font-semibold text-white">{inline(b.text, `h${i}`)}</h3>;
        if (b.kind === "p") return <p key={i}>{inline(b.text, `p${i}`)}</p>;
        const List = b.kind === "ul" ? "ul" : "ol";
        return (
          <List key={i} className={`space-y-1.5 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it, `l${i}-${j}`)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
