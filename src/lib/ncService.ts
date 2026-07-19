import { kv } from '@vercel/kv';
import { randomUUID } from 'crypto';
import {
  RoomServiceClient,
  AccessToken,
  type CreateOptions,
} from 'livekit-server-sdk';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Service layer shared by the /api/v1 public routes. Wraps LiveKit room
 * control, KV-backed meeting/event storage and R2 recording listing so the
 * route handlers stay thin. Reuses the same env vars as the web app.
 */

export interface Meeting {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: number;
  maxParticipants: number;
  status: 'open' | 'ended';
  metadata?: Record<string, unknown>;
}

export interface EventRecord {
  slug: string;
  title: string;
  ownerUserId: string;
  createdAt: number;
  visibility: 'public' | 'unlisted';
  replayReady: boolean;
}

export interface Recording {
  key: string;
  meetingId: string;
  sizeBytes: number;
  lastModified: string;
}

function roomClient(): RoomServiceClient {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    throw new Error('LiveKit environment is not configured.');
  }
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return new RoomServiceClient(httpUrl, key, secret);
}

function r2Client(): { client: S3Client; bucket: string } {
  const {
    STORAGE_ACCESS_KEY,
    STORAGE_SECRET_KEY,
    STORAGE_ENDPOINT,
    STORAGE_BUCKET,
    STORAGE_REGION,
  } = process.env;
  if (!STORAGE_ACCESS_KEY || !STORAGE_SECRET_KEY || !STORAGE_ENDPOINT || !STORAGE_BUCKET) {
    throw new Error('Storage environment is not configured.');
  }
  const client = new S3Client({
    region: STORAGE_REGION || 'auto',
    endpoint: STORAGE_ENDPOINT,
    credentials: {
      accessKeyId: STORAGE_ACCESS_KEY,
      secretAccessKey: STORAGE_SECRET_KEY,
    },
  });
  return { client, bucket: STORAGE_BUCKET };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'meeting'
  );
}

export async function createMeeting(input: {
  ownerUserId: string;
  name: string;
  maxParticipants: number;
  metadata?: Record<string, unknown>;
}): Promise<Meeting> {
  const id = randomUUID();
  const slug = `${slugify(input.name)}-${id.slice(0, 6)}`;
  const meeting: Meeting = {
    id,
    name: input.name,
    slug,
    ownerUserId: input.ownerUserId,
    createdAt: Date.now(),
    maxParticipants: input.maxParticipants,
    status: 'open',
    metadata: input.metadata,
  };

  const opts: CreateOptions = {
    name: slug,
    maxParticipants: input.maxParticipants,
    emptyTimeout: 60 * 10,
  };
  await roomClient().createRoom(opts);

  await kv.set(`meeting:${id}`, meeting);
  await kv.sadd(`meetings:user:${input.ownerUserId}`, id);
  return meeting;
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  return (await kv.get<Meeting>(`meeting:${id}`)) ?? null;
}

export async function listMeetings(ownerUserId: string): Promise<Meeting[]> {
  const ids = await kv.smembers(`meetings:user:${ownerUserId}`);
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((id) => kv.get<Meeting>(`meeting:${id}`)));
  return rows
    .filter((m): m is Meeting => Boolean(m))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function endMeeting(id: string): Promise<Meeting | null> {
  const meeting = await getMeeting(id);
  if (!meeting) return null;
  try {
    await roomClient().deleteRoom(meeting.slug);
  } catch {
    /* room may already be gone */
  }
  meeting.status = 'ended';
  await kv.set(`meeting:${id}`, meeting);
  return meeting;
}

export async function createJoinToken(input: {
  meeting: Meeting;
  identity: string;
  displayName?: string;
  canPublish?: boolean;
}): Promise<{ token: string; url: string; expiresAt: number }> {
  const key = process.env.LIVEKIT_API_KEY!;
  const secret = process.env.LIVEKIT_API_SECRET!;
  const ttlSeconds = 60 * 60;

  const at = new AccessToken(key, secret, {
    identity: input.identity,
    name: input.displayName,
    ttl: ttlSeconds,
  });
  at.addGrant({
    room: input.meeting.slug,
    roomJoin: true,
    canPublish: input.canPublish ?? true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  return {
    token,
    url: process.env.LIVEKIT_URL!,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
}

export async function listEvents(ownerUserId: string): Promise<EventRecord[]> {
  const slugs = await kv.smembers(`events:user:${ownerUserId}`);
  if (!slugs.length) return [];
  const rows = await Promise.all(slugs.map((s) => kv.get<EventRecord>(`event:${s}`)));
  return rows
    .filter((e): e is EventRecord => Boolean(e))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getEvent(slug: string): Promise<EventRecord | null> {
  return (await kv.get<EventRecord>(`event:${slug}`)) ?? null;
}

export async function listRecordings(meetingId: string): Promise<Recording[]> {
  const { client, bucket } = r2Client();
  const out = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `recordings/${meetingId}/` })
  );
  return (out.Contents ?? []).map((o) => ({
    key: o.Key!,
    meetingId,
    sizeBytes: o.Size ?? 0,
    lastModified: (o.LastModified ?? new Date()).toISOString(),
  }));
}

export async function signRecordingUrl(key: string, expiresIn = 3600): Promise<string> {
  const { client, bucket } = r2Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}
