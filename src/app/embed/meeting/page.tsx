"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
} from "@livekit/components-react";
import "@livekit/components-styles";

/**
 * Auth-free interactive meeting embed.
 *
 * Designed to be loaded inside an <iframe> on a third-party website.
 * The host site mints a short-lived guest join token server-side via
 * POST /api/v1/meetings/{id}/tokens and passes it here as ?token=...
 *
 * Query params:
 *   token (required) - LiveKit access token returned by the API
 *   url   (optional) - LiveKit server ws URL; falls back to
 *                       NEXT_PUBLIC_LIVEKIT_URL baked at build time
 *   theme (optional) - "dark" (default) or "light"
 */
export default function MeetingEmbedPage() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const urlParam = params.get("url") || "";
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const serverUrl = useMemo(() => {
    if (urlParam) return urlParam;
    return process.env.NEXT_PUBLIC_LIVEKIT_URL || "";
  }, [urlParam]);

  if (!mounted) {
    return <Shell>Loading…</Shell>;
  }

  if (!token) {
    return (
      <Shell>
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold text-white">Missing join token</h1>
          <p className="text-sm text-slate-400">
            This embed needs a valid <code className="text-cyan-300">token</code>{" "}
            query parameter. Mint one server-side with the NeoConference API and
            pass it in the iframe URL.
          </p>
        </div>
      </Shell>
    );
  }

  if (!serverUrl) {
    return (
      <Shell>
        <div className="max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold text-white">Server not configured</h1>
          <p className="text-sm text-slate-400">
            No LiveKit server URL was provided. Pass{" "}
            <code className="text-cyan-300">url</code> in the embed link.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <div
      style={{ height: "100vh", width: "100vw", background: "#03050a" }}
      data-lk-theme="default"
    >
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect={true}
        video={true}
        audio={true}
        style={{ height: "100%" }}
      >
        <VideoConference />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ height: "100vh", width: "100vw", background: "#03050a" }}
      className="flex items-center justify-center p-6 text-slate-100"
    >
      {children}
    </div>
  );
}
