"use client";

// src/components/SupportWidget.tsx
//
// The NeoSupport chat bubble (cdn.neosupport.org/neo-support.js), on every
// page but a meeting, where it would sit on top of the meeting's controls.
//
// The script draws inside its own shadow root, reads no cookies, and keeps
// only its own visitor token in localStorage. It boots itself from its
// <script> tag's data-tenant / data-api / data-open, and exposes
// window.NeoSupport { init, identify, destroy }, which is how a meeting
// hides it and how /support opens it.

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

/** The widget's public key for this site: meant to be in page source. */
export const SUPPORT_TENANT = "nsw_4N5_Kd3R2uBSoxax5RCPbFcV";
export const SUPPORT_API = "https://app.neosupport.org/api";

type NeoSupportApi = {
  init(options: { publicKey: string; apiUrl: string; open?: boolean }): void;
  destroy(): void;
};

function api(): NeoSupportApi | undefined {
  return (window as unknown as { NeoSupport?: NeoSupportApi }).NeoSupport;
}

// Meetings currently mounted. A counter, not a flag, so one meeting
// unmounting as the next mounts never shows the bubble in between.
let hiddenBy = 0;
let shown = false;

function show(open = false) {
  const ns = api();
  if (!ns || hiddenBy > 0) return;
  if (shown) ns.destroy();
  ns.init({ publicKey: SUPPORT_TENANT, apiUrl: SUPPORT_API, open });
  shown = true;
}

function hide() {
  api()?.destroy();
  shown = false;
}

/** Keeps the bubble off the screen while the calling component is up. */
export function useNoSupportWidget() {
  useEffect(() => {
    hiddenBy += 1;
    hide();
    return () => {
      hiddenBy -= 1;
      if (hiddenBy === 0) show();
    };
  }, []);
}

/** Opens the chat, loaded or not: /support, and the app's Help & support. */
export function useOpenSupportChat() {
  useEffect(() => {
    if (api()) show(true);
    // Not loaded yet: the <script> reads data-open, set for /support below.
  }, []);
}

export default function SupportWidget() {
  const path = usePathname() ?? "/";
  return (
    <Script
      src="https://cdn.neosupport.org/neo-support.js"
      data-tenant={SUPPORT_TENANT}
      data-api={SUPPORT_API}
      data-open={path === "/support" ? "true" : undefined}
      strategy="afterInteractive"
      onLoad={() => {
        // It booted itself from the tag. A meeting may already be up.
        shown = true;
        if (hiddenBy > 0) hide();
      }}
    />
  );
}
