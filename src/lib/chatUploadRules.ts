// src/lib/chatUploadRules.ts
//
// What may be attached in a chat — the meeting chat (/api/chat/upload) and
// group chat (/api/groups/[id]/upload) — so both refuse and accept the same
// files.

/** 10 MB a file. */
export const CHAT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// Images, PDFs, common Office documents, plain text and common archives.
// Anything else is refused up-front so chat can't hold executables.
export const CHAT_UPLOAD_ALLOWED = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
]);

export const CHAT_IMAGE_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
  "image/heif",
]);

/** Restrict to path-safe chars; keep the original extension for the card. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || "file";
  return (
    base
      .replace(/[^\w. \-]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 100) || "file"
  );
}
