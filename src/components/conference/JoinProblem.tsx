// src/components/conference/JoinProblem.tsx
//
// The screen for a join that did not get in: "Meeting full" (the meeting's
// own cap, or the whole service: src/lib/livekitCapacity.ts) or "Could not
// connect", with the reason and a way to try again.

import React from "react";

export default function JoinProblem({ full, message, onRetry }: { full: boolean; message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="min-h-[calc(100vh-65px)] flex flex-col items-center justify-center p-8 gap-3 text-center">
      <h1 className="text-xl font-semibold">{full ? "Meeting full" : "Could not connect"}</h1>
      <p className="text-sm opacity-70 max-w-md">{message}</p>
      <button type="button" onClick={onRetry} className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium hover:bg-white/20">
        Try again
      </button>
      <a href="/" className="mt-4 underline text-sm">
        ← Back to home
      </a>
    </div>
  );
}
