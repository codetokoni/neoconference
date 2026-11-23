import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { tmpdir } from 'node:os';
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';

/**
 * Cloudflare R2 client + helpers.
 *
 * R2 rejects the AWS "flexible checksums" extension on both REQUEST and
 * RESPONSE paths. We strip every checksum middleware the SDK might add and
 * also opt-out via the modern config flags (responseChecksumValidation /
 * requestChecksumCalculation) where supported, so SignatureDoesNotMatch
 * stops happening on List, Get and presigned URL operations.
 */

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error('Missing env: ' + name);
  return v;
}

export function isR2Configured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY &&
      process.env.S3_SECRET_KEY
  );
}

function stripChecksumMiddlewares(s3: S3Client): void {
  const names = [
    'flexibleChecksumsMiddleware',
    'flexibleChecksumsInputMiddleware',
    'flexibleChecksumsResponseMiddleware',
  ];
  for (const n of names) {
    try { s3.middlewareStack.remove(n); } catch {}
  }
}

// One client for the process. A new one per call read the SDK's
// configuration again (os.homedir, where the nightly backup's "too many open
// files" surfaced) and kept its own pool of connections open (2026-11-20).
let client: S3Client | null = null;
let clientFor = '';

/** How long a looked-up address is used before looking again. */
const LOOKUP_FRESH_MS = 10 * 60_000;

export type Resolver = (hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
type AgentLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/**
 * A name lookup that remembers its answers, for R2's connections.
 *
 * The nightly backup connects to R2 first, then spends two minutes reading
 * the store, then writes. On 22 and 23 Nov 2026 the write failed at the
 * name lookup ("getaddrinfo EBUSY …r2.cloudflarestorage.com"): the process
 * was short of file slots by then, and a lookup needs some. With this, the
 * write reuses the address found at the start. An answer is reused for
 * LOOKUP_FRESH_MS; after that it is looked up again, and if that fails the
 * last answer is used rather than failing.
 */
export function cachedLookup(resolve: Resolver = dnsLookup as unknown as Resolver, now: () => number = Date.now): AgentLookup {
  const known = new Map<string, { at: number; addresses: LookupAddress[] }>();
  const answer = (options: { all?: boolean }, list: LookupAddress[], cb: Parameters<AgentLookup>[2]) =>
    options.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  return (hostname, options, callback) => {
    const hit = known.get(hostname);
    if (hit && now() - hit.at < LOOKUP_FRESH_MS) return answer(options ?? {}, hit.addresses, callback);
    resolve(hostname, { ...(options?.family ? { family: options.family } : {}), all: true }, (err, list) => {
      if (!err && list?.length) {
        known.set(hostname, { at: now(), addresses: list });
        return answer(options ?? {}, list, callback);
      }
      if (hit) return answer(options ?? {}, hit.addresses, callback);
      callback(err ?? Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), [] as LookupAddress[]);
    });
  };
}

let resolverForTests: Resolver | undefined;

/** Tests only: how R2's name is looked up (undefined: the system's), and a new client. */
export function __setR2Resolver(r: Resolver | undefined): void {
  resolverForTests = r;
  client = null;
}

/** HOME for libraries that look up the home directory; a temporary folder if unset. */
export function ensureHome(): void {
  if (!process.env.HOME) process.env.HOME = tmpdir();
}

/**
 * Load the SDK's settings now, with one small request, while the process has
 * file slots to spare: they are read once and kept. The backup calls this
 * before reading the store, so writing the snapshot later needs only a
 * connection.
 */
export async function warmR2(): Promise<void> {
  const Bucket = requiredEnv('S3_BUCKET');
  await r2Client().send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
}

export function r2Client(): S3Client {
  const key = [process.env.S3_ENDPOINT, process.env.S3_ACCESS_KEY, process.env.S3_REGION].join('|');
  if (client && clientFor === key) return client;
  // The SDK looks up the home directory for its settings files. Without HOME
  // (as on Vercel) Node asks the system's user database, which needs a file
  // slot: the nightly backup failed there, "uv_os_homedir returned EMFILE",
  // whenever the process was out of them. With HOME set it needs none.
  ensureHome();
  // Cast to allow the newer config flags on older type defs.
  const config: ConstructorParameters<typeof S3Client>[0] & {
    requestChecksumCalculation?: 'WHEN_REQUIRED' | 'WHEN_SUPPORTED';
    responseChecksumValidation?: 'WHEN_REQUIRED' | 'WHEN_SUPPORTED';
  } = {
    region: process.env.S3_REGION || 'auto',
    endpoint: requiredEnv('S3_ENDPOINT'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv('S3_ACCESS_KEY'),
      secretAccessKey: requiredEnv('S3_SECRET_KEY'),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    // Connections kept open between requests, and R2's address remembered
    // (cachedLookup): a write late in a long job needs no name lookup.
    requestHandler: { httpsAgent: new HttpsAgent({ keepAlive: true, lookup: cachedLookup(resolverForTests) as never }) },
  };
  const s3 = new S3Client(config);
  stripChecksumMiddlewares(s3);
  client = s3;
  clientFor = key;
  return s3;
}

export type R2Object = {
  key: string;
  size: number;
  lastModified?: string;
  etag?: string;
};

export async function listRecordings(prefix?: string, max = 200): Promise<R2Object[]> {
  if (!isR2Configured()) return [];
  const s3 = r2Client();
  const out = await s3.send(
    new ListObjectsV2Command({
      Bucket: requiredEnv('S3_BUCKET'),
      Prefix: prefix,
      MaxKeys: max,
    })
  );
  const items: R2Object[] = (out.Contents || []).map((o) => ({
    key: o.Key || '',
    size: o.Size || 0,
    lastModified: o.LastModified ? o.LastModified.toISOString() : undefined,
    etag: o.ETag,
  }));
  items.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
  return items;
}

/**
 * Objects and bytes in the bucket, for the ops health page. Pages through
 * the listing (1000 keys a page) up to `maxPages`; `truncated` means there
 * were more, so the totals are a lower bound.
 */
export async function bucketUsage(maxPages = 20): Promise<{ objects: number; bytes: number; truncated: boolean }> {
  const s3 = r2Client();
  const Bucket = requiredEnv('S3_BUCKET');
  let objects = 0;
  let bytes = 0;
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000, ContinuationToken: token }));
    for (const o of out.Contents || []) {
      objects++;
      bytes += o.Size || 0;
    }
    if (!out.IsTruncated || !out.NextContinuationToken) return { objects, bytes, truncated: false };
    token = out.NextContinuationToken;
  }
  return { objects, bytes, truncated: true };
}

/** A whole object's bytes. For small objects (the ops snapshots); not streamed. */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  if (!isR2Configured()) throw new Error('R2 not configured');
  const s3 = r2Client();
  const out = await s3.send(new GetObjectCommand({ Bucket: requiredEnv('S3_BUCKET'), Key: key }));
  if (!out.Body) throw new Error('empty body');
  return await (out.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
}

export async function signGetUrl(key: string, expiresIn = 3600): Promise<string> {
  const s3 = r2Client();
  const cmd = new GetObjectCommand({
    Bucket: requiredEnv('S3_BUCKET'),
    Key: key,
  });
  return getSignedUrl(s3, cmd, { expiresIn });
}
export async function deleteObject(key: string): Promise<void> {
  if (!isR2Configured()) throw new Error('R2 not configured');
  const s3 = r2Client();
  await s3.send(
    new DeleteObjectCommand({
      Bucket: requiredEnv('S3_BUCKET'),
      Key: key,
    })
  );
}

export async function renameObject(oldKey: string, newKey: string): Promise<void> {
  if (!isR2Configured()) throw new Error('R2 not configured');
  if (!oldKey || !newKey || oldKey === newKey) throw new Error('invalid keys');
  const s3 = r2Client();
  const Bucket = requiredEnv('S3_BUCKET');
  await s3.send(
    new CopyObjectCommand({
      Bucket,
      CopySource: encodeURIComponent(Bucket + '/' + oldKey),
      Key: newKey,
    })
  );
  await s3.send(
    new DeleteObjectCommand({
      Bucket,
      Key: oldKey,
    })
  );
}

/**
 * Put a small object into R2. Used by chat attachment upload — the
 * whole file is read into memory server-side, so callers must enforce
 * a size cap BEFORE this is called (the multipart parser or the
 * upload route). No streaming path yet; recordings use a separate
 * multipart-upload pipeline that isn't reused here.
 */
export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  opts?: { cacheControl?: string }
): Promise<void> {
  if (!isR2Configured()) throw new Error('R2 not configured');
  const s3 = r2Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: requiredEnv('S3_BUCKET'),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: opts?.cacheControl,
    })
  );
}

/**
 * One page of the bucket listing, in key order, for the content index's
 * backfill (src/lib/content/backfill.ts). Read-only. `token` is the
 * previous page's `next`; null when the listing is complete.
 */
export async function listObjectsPage(opts: { prefix?: string; token?: string | null; maxKeys?: number } = {}): Promise<{
  objects: R2Object[];
  next: string | null;
}> {
  if (!isR2Configured()) return { objects: [], next: null };
  const s3 = r2Client();
  const out = await s3.send(
    new ListObjectsV2Command({
      Bucket: requiredEnv('S3_BUCKET'),
      Prefix: opts.prefix,
      MaxKeys: Math.min(Math.max(opts.maxKeys ?? 1000, 1), 1000),
      ContinuationToken: opts.token || undefined,
    })
  );
  return {
    objects: (out.Contents || []).map((o) => ({
      key: o.Key || '',
      size: o.Size || 0,
      lastModified: o.LastModified ? o.LastModified.toISOString() : undefined,
      etag: o.ETag,
    })),
    next: out.IsTruncated && out.NextContinuationToken ? out.NextContinuationToken : null,
  };
}

/** An object's size and checksum without its bytes; null when there is none. Read-only. */
export async function headObject(key: string): Promise<{ size: number; etag?: string; contentType?: string; lastModified?: string } | null> {
  if (!isR2Configured()) return null;
  const s3 = r2Client();
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: requiredEnv('S3_BUCKET'), Key: key }));
    return {
      size: out.ContentLength || 0,
      etag: out.ETag,
      contentType: out.ContentType,
      lastModified: out.LastModified ? out.LastModified.toISOString() : undefined,
    };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404 || (err as { name?: string })?.name === 'NotFound') return null;
    throw err;
  }
}

/**
 * Every object under `prefix`, paging through the listing (1000 keys a
 * page) up to `maxPages`. For data governance: an account's recordings and
 * uploads, files past their retention. `truncated` means there were more.
 */
export async function listAllObjects(prefix: string, maxPages = 50): Promise<{ items: R2Object[]; truncated: boolean }> {
  if (!isR2Configured()) return { items: [], truncated: false };
  const s3 = r2Client();
  const Bucket = requiredEnv('S3_BUCKET');
  const items: R2Object[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const out = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
    for (const o of out.Contents || []) {
      items.push({ key: o.Key || '', size: o.Size || 0, lastModified: o.LastModified ? o.LastModified.toISOString() : undefined, etag: o.ETag });
    }
    if (!out.IsTruncated || !out.NextContinuationToken) return { items, truncated: false };
    token = out.NextContinuationToken;
  }
  return { items, truncated: true };
}
