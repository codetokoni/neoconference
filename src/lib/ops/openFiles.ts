// src/lib/ops/openFiles.ts
//
// How many files and sockets this process has open, for a job that can run
// out of them. The nightly backup failed about every other night from 13 Nov
// 2026 with "uv_os_homedir returned EMFILE (too many open files)" two minutes
// in, and nothing said which step or what was holding them: its errors and
// summary now carry this.
//
// Linux only (/proc/self/fd, as on Vercel); null elsewhere, or when even the
// directory cannot be opened because nothing is left.

import { readdirSync, readlinkSync } from "node:fs";

export function openFiles(): { total: number; sockets: number } | null {
  try {
    const fds = readdirSync("/proc/self/fd");
    let sockets = 0;
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:")) sockets++;
      } catch {
        // Closed while counting.
      }
    }
    return { total: fds.length, sockets };
  } catch {
    return null;
  }
}

export function openFilesText(): string {
  const o = openFiles();
  return o ? `${o.total} open, ${o.sockets} sockets` : "open files unknown";
}

/**
 * Out of file slots, however it shows: "too many open files" (EMFILE, or
 * ENFILE for the whole system), or a name lookup that could not run for want
 * of them ("getaddrinfo EBUSY", 22 and 23 Nov 2026; EAI_AGAIN).
 */
export const isTooManyOpenFiles = (e: unknown): boolean =>
  /EMFILE|ENFILE|too many open files|getaddrinfo (EBUSY|EAI_AGAIN)/i.test(e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}` : String(e));

/**
 * How long to wait before each retry. The process shares its file slots with
 * other requests served beside it, whose connections come and go: one retry
 * after 3 s was not enough (21 Nov 2026: 546 sockets open while the backup's
 * own reads used at most 3).
 */
export const TOO_MANY_OPEN_FILES_WAITS_MS = [3000, 10_000, 30_000];

/**
 * Run `fn`; if the process had run out of file slots, wait for some to close
 * (sockets kept alive by finished requests time out) and try again, once per
 * wait. Any other failure is not retried.
 */
export async function retryOnTooManyOpenFiles<T>(fn: () => Promise<T>, waits: number | number[] = TOO_MANY_OPEN_FILES_WAITS_MS): Promise<T> {
  const list = Array.isArray(waits) ? waits : [waits];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTooManyOpenFiles(e) || i >= list.length) throw e;
      await new Promise((r) => setTimeout(r, list[i]));
    }
  }
}

/** Run one step of a job; a failure says which step, and what was open then. */
export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${name}: ${msg} (${openFilesText()})`);
  }
}
