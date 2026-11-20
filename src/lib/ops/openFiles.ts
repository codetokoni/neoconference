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

export const isTooManyOpenFiles = (e: unknown): boolean =>
  /EMFILE|too many open files/i.test(e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}` : String(e));

/**
 * Run `fn`; if the process had run out of file slots, wait for some to close
 * (sockets kept alive by finished requests time out) and try once more.
 */
export async function retryOnTooManyOpenFiles<T>(fn: () => Promise<T>, waitMs = 3000): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isTooManyOpenFiles(e)) throw e;
    await new Promise((r) => setTimeout(r, waitMs));
    return fn();
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
