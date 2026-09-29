"use client";

import { useOpenSupportChat } from "@/components/SupportWidget";

/** Opens the chat when /support is reached by navigating within the site. */
export default function SupportChatOpener() {
  useOpenSupportChat();
  return null;
}
