import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
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

export async function signGetUrl(key: string, expiresIn = 3600): Promise<string> {
  const s3 = r2Client();
  const cmd = new GetObjectCommand({
    Bucket: requiredEnv('S3_BUCKET'),
    Key: key,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn });
  // Strip extension query params R2 cannot validate.
  const u = new URL(url);
  u.searchParams.delete('x-amz-checksum-mode');
  u.searchParams.delete('x-id');
  return u.toString();
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
