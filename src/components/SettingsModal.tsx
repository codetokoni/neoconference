"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import MicLevelMeter from "./MicLevelMeter";
import SpeakerTestButton from "./SpeakerTestButton";

/**
 * SettingsModal
 *
 * Consolidated settings hub. Matches Zoom / Google Meet / Jitsi by giving users
 * one place to manage audio, video, and meeting preferences instead of hunting
 * across toolbar buttons.
 *
 * Tabs:
 *   - Audio     : mic + speaker device pickers, noise suppression, echo cancel,
 *                 auto gain control (reads / writes the same localStorage keys
 *                 already used by the prejoin pills so prefs stay coherent).
 *   - Video     : camera device picker, background blur toggle, captions toggle
 *                 (all delegated via window CustomEvents so we never duplicate
 *                 stateful logic from existing in-room components).
 *   - General   : keyboard shortcuts launcher, reduced-motion status,
 *                 leave-confirm trigger reference.
 *   - About     : product name, build channel marker.
 *
 * Open via:
 *   - The floating gear button (mounted automatically by this component).
 *   - The "settings:open" window CustomEvent (so toolbars can dispatch it).
 *   - Ctrl/Cmd + ",".
 *
 * Close via: Esc, backdrop click, or the dedicated Close control.
 *
 * Safety:
 *   - Ignored while focus is in an input / textarea / contenteditable so it
 *     never hijacks typing in chat.
 *   - role="dialog", aria-modal, aria-labelledby, focus trap, focus restoration.
 *   - prefers-reduced-motion respected for the fade animation.
 */

const LS = {
  ns: "neoconf:audio:noiseSuppression",
  ec: "neoconf:audio:echoCancellation",
  agc: "neoconf:audio:autoGainControl",
  micId: "neoconf:device:mic",
  camId: "neoconf:device:cam",
  spkId: "neoconf:device:spk",
};

type Tab = "audio" | "video" | "general" | "about";

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* ignore */ }
}

function readStr(key: string): string {
  if (typeof window === "undefined") return "";
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}

function writeStr(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* ignore */ }
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

async function listDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return [];
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

export default function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("audio");
  const openerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  // Device lists (refreshed when modal opens / on devicechange).
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [spks, setSpks] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState<string>(() => readStr(LS.micId));
  const [camId, setCamId] = useState<string>(() => readStr(LS.camId));
  const [spkId, setSpkId] = useState<string>(() => readStr(LS.spkId));

  // Audio processing toggles.
  const [ns, setNs] = useState<boolean>(() => readBool(LS.ns, true));
  const [ec, setEc] = useState<boolean>(() => readBool(LS.ec, true));
  const [agc, setAgc] = useState<boolean>(() => readBool(LS.agc, true));

  const canSetSink = useMemo(() => {
    if (typeof window === "undefined") return false;
    return typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId === "function";
  }, []);

  const openDialog = useCallback(() => {
    if (typeof document !== "undefined") {
      const active = document.activeElement;
      if (active instanceof HTMLElement) openerRef.current = active;
    }
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Global trigger: Ctrl/Cmd + "," opens, ignored in editable fields.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (open) return;
      if (isEditableTarget(e.target)) return;
      if (e.key === "," && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openDialog();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openDialog]);

  // Programmatic open via CustomEvent.
  useEffect(() => {
    function onOpen() { openDialog(); }
    window.addEventListener("settings:open", onOpen as EventListener);
    return () => window.removeEventListener("settings:open", onOpen as EventListener);
  }, [openDialog]);

  // Refresh device lists when modal opens and on devicechange.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function refresh() {
      const devs = await listDevices();
      if (cancelled) return;
      setMics(devs.filter(d => d.kind === "audioinput"));
      setCams(devs.filter(d => d.kind === "videoinput"));
      setSpks(devs.filter(d => d.kind === "audiooutput"));
    }
    refresh();
    const onChange = () => { refresh(); };
    try {
      navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    } catch { /* ignore */ }
    return () => {
      cancelled = true;
      try {
        navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
      } catch { /* ignore */ }
    };
  }, [open]);

  // Focus management + Esc + focus trap while open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => { closeBtnRef.current?.focus(); }, 0);

    function getFocusable(): HTMLElement[] {
      const root = dialogRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea'
        )
      );
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Tab") {
        const focusable = getFocusable();
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    }

    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      const opener = openerRef.current;
      if (opener && document.contains(opener)) {
        try { opener.focus(); } catch { /* ignore */ }
      }
    };
  }, [open, close]);

  // Setters that persist + broadcast for in-room components to pick up.
  const applyMic = useCallback((id: string) => {
    setMicId(id);
    writeStr(LS.micId, id);
    window.dispatchEvent(new CustomEvent("neoconf:device-select", { detail: { kind: "audioinput", deviceId: id } }));
  }, []);

  const applyCam = useCallback((id: string) => {
    setCamId(id);
    writeStr(LS.camId, id);
    window.dispatchEvent(new CustomEvent("neoconf:device-select", { detail: { kind: "videoinput", deviceId: id } }));
  }, []);

  const applySpk = useCallback((id: string) => {
    setSpkId(id);
    writeStr(LS.spkId, id);
    window.dispatchEvent(new CustomEvent("neoconf:device-select", { detail: { kind: "audiooutput", deviceId: id } }));
  }, []);

  const applyNs = useCallback((v: boolean) => { setNs(v); writeBool(LS.ns, v); window.dispatchEvent(new CustomEvent("neoconf:audio-prefs", { detail: { ns: v } })); }, []);
  const applyEc = useCallback((v: boolean) => { setEc(v); writeBool(LS.ec, v); window.dispatchEvent(new CustomEvent("neoconf:audio-prefs", { detail: { ec: v } })); }, []);
  const applyAgc = useCallback((v: boolean) => { setAgc(v); writeBool(LS.agc, v); window.dispatchEvent(new CustomEvent("neoconf:audio-prefs", { detail: { agc: v } })); }, []);

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <>
      {/* Floating gear button — bottom-right, just above the keyboard-shortcuts launcher. */}
      <button
        type="button"
        aria-label="Settings"
        aria-keyshortcuts="Control+,"
        title="Settings (Ctrl+,)"
        onClick={openDialog}
        style={{
          position: "fixed",
          right: 14,
          bottom: 60,
          zIndex: 60,
          width: 36,
          height: 36,
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.18)",
          background: "rgba(20,22,30,0.72)",
          color: "#f6f7fb",
          fontSize: 16,
          cursor: "pointer",
          backdropFilter: "blur(8px)",
          boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        ⚙
      </button>

      {open && (
        <div
          role="presentation"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1050,
            background: "rgba(8, 10, 18, 0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            animation: reduceMotion ? undefined : "sett-fade 140ms ease-out",
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sett-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 100%)",
              maxHeight: "min(86vh, 720px)",
              display: "flex",
              flexDirection: "column",
              background: "linear-gradient(180deg, #1b1e29 0%, #14161e 100%)",
              color: "#f6f7fb",
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <h2 id="sett-title" style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Settings</h2>
              <button
                ref={closeBtnRef}
                type="button"
                onClick={close}
                aria-label="Close settings"
                style={{ background: "transparent", color: "#cbd0dc", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer" }}
              >
                Esc
              </button>
            </div>

            <div role="tablist" aria-label="Settings sections" style={{ display: "flex", gap: 4, padding: "10px 14px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              {(["audio","video","general","about"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "8px 8px 0 0",
                    border: "1px solid " + (tab === t ? "rgba(255,255,255,0.14)" : "transparent"),
                    borderBottom: tab === t ? "1px solid #14161e" : "1px solid transparent",
                    background: tab === t ? "rgba(255,255,255,0.04)" : "transparent",
                    color: tab === t ? "#f6f7fb" : "#aab0c0",
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "capitalize",
                    cursor: "pointer",
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px 22px" }}>
              {tab === "audio" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Field label="Microphone">
                    <Select value={micId} onChange={applyMic} options={mics} fallbackLabel="Default microphone" />
                  </Field>
                  <Field label="Test microphone" hint="Verifies your mic is picking up sound. Bars react when you speak. Uses a separate stream so noise suppression / echo cancellation are bypassed for an honest level.">
                    <MicLevelMeter deviceId={micId} />
                  </Field>
                  <Field label="Speaker" hint={canSetSink ? undefined : "Speaker selection isn't supported in this browser. System default will be used."}>
                    <Select value={spkId} onChange={applySpk} options={spks} fallbackLabel="Default speaker" disabled={!canSetSink} />
                    <SpeakerTestButton deviceId={spkId} canSetSink={canSetSink} />
                  </Field>
                  <fieldset style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px 14px", margin: 0 }}>
                    <legend style={{ padding: "0 6px", fontSize: 11, color: "#9aa2b4", textTransform: "uppercase", letterSpacing: 1.1 }}>Audio processing</legend>
                    <Toggle label="Noise suppression" hint="Suppress fans, keyboards, paper rustles." on={ns} onChange={applyNs} />
                    <Toggle label="Echo cancellation" hint="Remove your speaker output from your mic." on={ec} onChange={applyEc} />
                    <Toggle label="Auto gain control" hint="Even out loud and quiet speech automatically." on={agc} onChange={applyAgc} />
                  </fieldset>
                </div>
              )}

              {tab === "video" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Field label="Camera">
                    <Select value={camId} onChange={applyCam} options={cams} fallbackLabel="Default camera" />
                  </Field>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <ActionRow
                      label="Background blur"
                      hint="Hide your room with a privacy-friendly background."
                      cta="Toggle"
                      onClick={() => window.dispatchEvent(new CustomEvent("neoconf:background-blur:toggle"))}
                    />
                    <ActionRow
                      label="Live captions"
                      hint="On-screen real-time transcription."
                      cta="Toggle"
                      onClick={() => window.dispatchEvent(new CustomEvent("neoconf:captions:toggle"))}
                    />
                    <ActionRow
                      label="Picture-in-Picture"
                      hint="Pop the active speaker into a floating window."
                      cta="Open"
                      onClick={() => window.dispatchEvent(new CustomEvent("neoconf:pip:open"))}
                    />
                  </div>
                </div>
              )}

              {tab === "general" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <ActionRow
                    label="Keyboard shortcuts"
                    hint="See every shortcut, with platform-aware keys."
                    cta="Open"
                    onClick={() => window.dispatchEvent(new CustomEvent("ksh:open"))}
                  />
                  <InfoRow label="Reduced motion" value={reduceMotion ? "On (system)" : "Off (system)"} />
                  <InfoRow label="Browser" value={typeof navigator !== "undefined" ? navigator.userAgent.split(") ")[0].split(" (")[0] : "Unknown"} />
                </div>
              )}

              {tab === "about" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>NeoConference</h3>
                  <p style={{ margin: 0, fontSize: 12, color: "#aab0c0", lineHeight: 1.6 }}>
                    Premium HD video meetings. Built to match the capabilities you expect from
                    Zoom, Google Meet, and Jitsi — with a focus on accessibility, privacy,
                    and clarity.
                  </p>
                  <p style={{ margin: 0, fontSize: 11, color: "#737a8a" }}>Build channel: preview</p>
                </div>
              )}
            </div>
          </div>

          <style>{`
            @keyframes sett-fade {
              from { opacity: 0; transform: translateY(4px); }
              to   { opacity: 1; transform: translateY(0); }
            }
          `}</style>
        </div>
      )}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11, color: "#9aa2b4", textTransform: "uppercase", letterSpacing: 1.1 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: "#737a8a", lineHeight: 1.45 }}>{hint}</span>}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
  fallbackLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: MediaDeviceInfo[];
  fallbackLabel: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        background: "rgba(255,255,255,0.04)",
        color: disabled ? "#737a8a" : "#f6f7fb",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 13,
        outline: "none",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <option value="">{fallbackLabel}</option>
      {options.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || (d.kind + " " + d.deviceId.slice(0, 6))}
        </option>
      ))}
    </select>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: "1px dashed rgba(255,255,255,0.06)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: "#dfe3ee" }}>{label}</span>
        {hint && <span style={{ fontSize: 11, color: "#737a8a" }}>{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        style={{
          flex: "0 0 auto",
          width: 40,
          height: 22,
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.18)",
          background: on ? "rgba(56, 189, 248, 0.6)" : "rgba(255,255,255,0.06)",
          position: "relative",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: 999,
            background: "white",
            transition: "left 120ms ease",
          }}
        />
      </button>
    </div>
  );
}

function ActionRow({ label, hint, cta, onClick }: { label: string; hint?: string; cta: string; onClick: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, color: "#dfe3ee" }}>{label}</span>
        {hint && <span style={{ fontSize: 11, color: "#737a8a" }}>{hint}</span>}
      </div>
      <button
        type="button"
        onClick={onClick}
        style={{
          flex: "0 0 auto",
          padding: "6px 12px",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.18)",
          background: "rgba(255,255,255,0.05)",
          color: "#f6f7fb",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {cta}
      </button>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 12px", borderRadius: 8 }}>
      <span style={{ fontSize: 12, color: "#9aa2b4", textTransform: "uppercase", letterSpacing: 1.1 }}>{label}</span>
      <span style={{ fontSize: 12, color: "#dfe3ee", textAlign: "right" }}>{value}</span>
    </div>
  );
}
