// src/lib/groupChatView.ts
//
// Group chat messages as the API sends them: each attachment gets a freshly
// signed link (24 h), since messages keep only the R2 key.

import { isR2Configured, signGetUrl } from "@/lib/r2";
import type { GroupChatMessage } from "@/lib/groupChat";

export type ChatMessageView = Omit<GroupChatMessage, "attachments"> & {
  attachments?: Array<{ url: string | null; name: string; size: number; mime: string; kind: "image" | "file" }>;
};

const LINK_SECONDS = 24 * 60 * 60;

export async function viewMessages(messages: GroupChatMessage[]): Promise<ChatMessageView[]> {
  const r2 = isR2Configured();
  return Promise.all(
    messages.map(async (m) => {
      if (!m.attachments?.length) return m as ChatMessageView;
      const attachments = await Promise.all(
        m.attachments.map(async (a) => ({
          url: r2 ? await signGetUrl(a.key, LINK_SECONDS).catch(() => null) : null,
          name: a.name,
          size: a.size,
          mime: a.mime,
          kind: a.kind,
        }))
      );
      return { ...m, attachments };
    })
  );
}
