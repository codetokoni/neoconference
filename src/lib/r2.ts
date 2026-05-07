import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cloudflare R2 client + helpers.
 *
 * Uses the S3-compatible API. The "flexibleChecksumsMiddleware" is removed
 * because R2 rejects the AWS x-amz-checksum-mode header — leaving it on
 * causes SignatureDoesNotMatch on signed GETs.
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

export function r2Client(): S3Client {
  const s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: requiredEnv('S3_ENDPOINT'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnv('S3_ACCESS_KEY'),
      secretAccessKey: requiredEnv('S3_SECRET_KEY'),
    },
  });
  try {
    s3.middlewareStack.remove('flexibleChecksumsMiddleware');
  } catch {
    // already removed or not present
  }
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
  // Newest first.
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
  // Strip extension headers R2 cannot validate.
  const u = new URL(url);
  u.searchParams.delete('x-amz-checksum-mode');
  u.searchParams.delete('x-id');
  return u.toString();
}
