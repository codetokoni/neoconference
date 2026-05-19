"use client";

// src/app/admin/events/Toaster.tsx
// Tiny self-contained toaster for the admin events page. No dep. Stacks
// top-right, auto-dismisses after 4s, click X to dismiss early. Imperative
// API via the useToaster() hook.

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";

export type ToastKind = "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface ToasterApi {
  pushToast: (toast: { kind: ToastKind; text: string }) => void;
  Toaster: () => React.ReactElement | null;
}

const AUTO_DISMISS_MS = 4000;

export function useToaster(): ToasterApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const pushToast = useCallback((toast: { kind: ToastKind; text: string }) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, ...toast }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const Toaster = useCallback((): React.ReactElement | null => {
    if (toasts.length === 0) return null;
    return (
      <div
        aria-live="polite"
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    );
  }, [toasts, dismiss]);

  return { pushToast, Toaster };
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [onDismiss]);

  const Icon = toast.kind === "success" ? CheckCircle2 : XCircle;
  const iconClass = toast.kind === "success" ? "text-cyan-400" : "text-rose-400";
  const borderClass =
    toast.kind === "success"
      ? "border-cyan-400/30"
      : "border-rose-500/30";

  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-center gap-3 rounded-2xl border bg-black/70 px-4 py-3 text-sm text-zinc-100 shadow-[0_8px_24px_rgba(0,0,0,0.4)] backdrop-blur-xl ${borderClass}`}
      style={{ borderWidth: "0.5px" }}
    >
      <Icon className={`h-4 w-4 flex-shrink-0 ${iconClass}`} aria-hidden="true" />
      <span className="flex-1 min-w-0">{toast.text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 text-zinc-500 transition-colors hover:text-zinc-200"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
