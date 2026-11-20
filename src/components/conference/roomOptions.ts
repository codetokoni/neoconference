// src/components/conference/roomOptions.ts
//
// How the web meeting room's LiveKit connection receives video.
//
// LiveKit's defaults send every camera in the meeting to every browser, at
// full quality, whether or not its tile is on the screen (adaptiveStream and
// dynacast off). In a meeting of 700 people on 20 November 2026, mostly on
// phones, that was more than a phone's connection could take: it stopped
// working, LiveKit's own client gave up after its 15-second connection timeout
// and started again, and did so over and over — 14,943 joins by 713 people in
// an hour, the median stay 22 seconds, with the sound going on and off. The
// phone app already sets both (mobile/lib/src/room/room_controller.dart).
//
//   adaptiveStream  a video is only received while its tile is on screen, at
//                   the size it is shown; tiles scrolled away are paused.
//   dynacast        a camera only sends the layers someone is watching.
//
// Video keeps flowing while the tab is in the background
// (pauseVideoInBackground: false), so the floating video window (MeetingPiP)
// never freezes when you switch away to another tab or app.
//
// Each tile's video is asked for at the tile's size on the page
// (pixelDensity: 1), not at the screen's extra sharpness. LiveKit's default
// doubles it on screens denser than 2x, which are phones: a phone's 3-column
// tiles then asked for a bigger layer than they show. Measured on 2026-11-20
// (a local LiveKit, 50 cameras, a 390-px-wide phone at 3x): before #654 the
// phone received 65 Mbps; with adaptiveStream 11.5 Mbps; with this as well
// about 5.6 Mbps, for small tiles a little softer. Computers (2x or less)
// already asked at 1, so nothing changes there; screen shares are sent in one
// quality, so slides stay sharp.

import type { RoomOptions } from "livekit-client";

export const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: { pauseVideoInBackground: false, pixelDensity: 1 },
  dynacast: true,
};

/**
 * What to publish on joining: what was chosen on the join screen. The room
 * used to publish camera and microphone for everyone and turn them off a
 * moment later (ApplyPrejoinChoices), so each arrival in a meeting of
 * hundreds sent a burst of video to everyone first. The in-room buttons
 * start a camera or microphone that was never published
 * (setCameraEnabled / setMicrophoneEnabled create the track).
 */
export function joinMedia(
  enabled: boolean | undefined,
  deviceId: string | undefined,
): boolean | { deviceId: { ideal: string } } {
  if (enabled === false) return false;
  return deviceId ? { deviceId: { ideal: deviceId } } : true;
}
