import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

export function r2Client(): S3Client {
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
  };
  const s3 = new S3Client(config);
  stripChecksumMiddlewares(s3);
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
