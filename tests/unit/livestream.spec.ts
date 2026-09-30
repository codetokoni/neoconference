import { test, expect } from "@playwright/test";
import {
  destinationProblem,
  destinationStatus,
  liveOnText,
  publicDestination,
  rtmpUrlFor,
} from "../../src/lib/livestream";

/**
 * Livestreaming a meeting to YouTube, Facebook, Twitch or an RTMP address.
 * The key is a secret: it reaches LiveKit in the URL and is never kept.
 */
test.describe("the address LiveKit is given", () => {
  test("is the platform's ingest with the key on the end", () => {
    expect(rtmpUrlFor({ platform: "youtube", key: " abcd-1234-efgh-5678 " })).toBe(
      "rtmp://a.rtmp.youtube.com/live2/abcd-1234-efgh-5678"
    );
    expect(rtmpUrlFor({ platform: "facebook", key: "FB-KEY-123456" })).toBe(
      "rtmps://live-api-s.facebook.com:443/rtmp/FB-KEY-123456"
    );
    expect(rtmpUrlFor({ platform: "twitch", key: "live_123_abcdef" })).toBe(
      "rtmp://live.twitch.tv/app/live_123_abcdef"
    );
  });

  test("is the address itself for a custom RTMP destination", () => {
    expect(rtmpUrlFor({ platform: "rtmp", key: "rtmps://ingest.example.com/live/k1" })).toBe(
      "rtmps://ingest.example.com/live/k1"
    );
  });
});

test.describe("what the host typed", () => {
  test("a key is required, and pasted alone", () => {
    expect(destinationProblem({ platform: "youtube", key: "" })).toBe("Enter the stream key.");
    expect(destinationProblem({ platform: "youtube", key: "rtmp://a.rtmp.youtube.com/live2/x" })).toContain(
      "just the stream key"
    );
    expect(destinationProblem({ platform: "youtube", key: "has a space" })).toContain("no spaces");
    expect(destinationProblem({ platform: "youtube", key: "abcd-1234-efgh-5678" })).toBeNull();
  });

  test("a custom destination needs an rtmp address", () => {
    expect(destinationProblem({ platform: "rtmp", key: "" })).toBe("Enter the RTMP address.");
    expect(destinationProblem({ platform: "rtmp", key: "https://example.com" })).toContain("rtmp://");
    expect(destinationProblem({ platform: "rtmp", key: "rtmp://example.com/live/key" })).toBeNull();
  });
});

test.describe("what is kept", () => {
  test("the platform and a name, never the key", () => {
    const kept = publicDestination({ platform: "youtube", key: "SECRET-KEY-1234", label: "  Church channel " });
    expect(kept).toEqual({ platform: "youtube", label: "Church channel" });
    expect(JSON.stringify(kept)).not.toContain("SECRET");
    expect(publicDestination({ platform: "twitch", key: "k" })).toEqual({ platform: "twitch", label: "Twitch" });
  });
});

test.describe("what LiveKit says about each destination", () => {
  test("maps its statuses to words", () => {
    expect(destinationStatus(undefined)).toEqual({ status: "connecting" });
    expect(destinationStatus({ status: 0, error: "" } as never)).toEqual({ status: "live" });
    expect(destinationStatus({ status: 1, error: "" } as never)).toEqual({ status: "ended" });
    expect(destinationStatus({ status: 2, error: "connection refused" } as never)).toEqual({
      status: "failed",
      error: "connection refused",
    });
  });
});

test("the live line names the platforms", () => {
  expect(liveOnText([])).toBe("Live");
  expect(liveOnText([{ platform: "youtube", label: "YouTube" }])).toBe("Live on YouTube");
  expect(
    liveOnText([
      { platform: "youtube", label: "YouTube" },
      { platform: "facebook", label: "Facebook" },
      { platform: "rtmp", label: "Church TV" },
    ])
  ).toBe("Live on YouTube, Facebook and Church TV");
});
