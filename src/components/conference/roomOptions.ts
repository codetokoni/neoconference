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

import type { RoomOptions } from "livekit-client";

export const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: { pauseVideoInBackground: false },
  dynacast: true,
};
