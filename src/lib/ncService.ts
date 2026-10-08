import { kv } from '@/lib/kv';
import { randomUUID } from 'crypto';
import {
  RoomServiceClient,
  AccessToken,
  type CreateOptions,
} from 'livekit-server-sdk';

/**
 * Service layer for the /api/v1 meetings: LiveKit room control and the
 * KV-backed meeting records, so the route handlers stay thin. Events and
 * recordings come from the website's own stores (lib/apiShapes.ts); the
 * copies that used to be here read keys nothing wrote. Reuses the same env
 * vars as the web app.
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

function livekitUrl(): string {
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!url) throw new Error('NEXT_PUBLIC_LIVEKIT_URL is not configured.');
  return url;
}

function roomClient(): RoomServiceClient {
  const url = livekitUrl();
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!key || !secret) {
    throw new Error('LiveKit API credentials are not configured.');
  }
  const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return new RoomServiceClient(httpUrl, key, secret);
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
    url: livekitUrl(),
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
}
