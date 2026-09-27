// src/app/room/[name]/layout.tsx
//
// Keeps meeting rooms out of search results. Every unclaimed top-level
// address is rewritten here (src/middleware.ts, so the first signed-in
// visitor can claim it), so without this any made-up URL was an indexable
// page. Lives in a layout because the room page is a client component and
// cannot export metadata.

import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  return children;
}
