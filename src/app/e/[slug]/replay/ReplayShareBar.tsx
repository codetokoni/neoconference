"use client";

// src/app/e/[slug]/replay/ReplayShareBar.tsx
// Client-only "copy replay link" + social share bar for the public replay page.

import { useState } from "react";

type Props = {
  url: string;
  title: string;
};

export default function ReplayShareBar({ url, title }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      window.prompt("Copy this replay link:", url);
    }
  };

  const enc = encodeURIComponent;
  const tweet = `https://twitter.com/intent/tweet?text=${enc(title)}&url=${enc(url)}`;
  const linked = `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onCopy}
        className="px-3 py-1.5 rounded-full bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 text-cyan-200 text-xs transition"
      >
        {copied ? "Link copied!" : "Copy replay link"}
      </button>
      <a
        href={tweet}
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs transition"
      >
        Share on X
      </a>
      <a
        href={linked}
        target="_blank"
        rel="noopener noreferrer"
        className="px-3 py-1.5 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs transition"
      >
        Share on LinkedIn
      </a>
    </div>
  );
}
