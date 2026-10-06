"use client";

// Where a group invite link lands. Anyone can see which group it is for;
// joining needs an account, so a signed-out visitor goes through sign-in and
// comes straight back here.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { groupErrorFrom, groupErrorMessage } from "@/lib/groupMessages";
import GroupIcon from "@/app/dashboard/groups/GroupIcon";
import UpgradeHint from "@/components/groups/UpgradeHint";

interface Preview {
  group: { id?: string; name: string; description: string; iconUrl: string; memberCount: number };
  invite: { expiresAt: string };
  signedIn: boolean;
  alreadyMember: boolean;
}

export default function JoinGroupPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const res = await fetch(`/api/groups/invite/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (!res.ok) {
        setLoadErr(await groupErrorFrom(res));
        return;
      }
      setPreview((await res.json()) as Preview);
    } catch {
      setLoadErr(groupErrorMessage(null));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function join() {
    setJoining(true);
    setJoinErr(null);
    try {
      const res = await fetch(`/api/groups/invite/${encodeURIComponent(token)}`, { method: "POST" });
      if (!res.ok) {
        setJoinErr(await groupErrorFrom(res));
        setJoining(false);
        return;
      }
      const data = (await res.json()) as { groupId: string };
      router.push(`/dashboard/groups/${encodeURIComponent(data.groupId)}`);
    } catch {
      setJoinErr(groupErrorMessage(null));
      setJoining(false);
    }
  }

  const back = `/groups/join/${encodeURIComponent(token)}`;

  return (
    <main className="min-h-screen bg-[#05070d] text-white flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#0a0b12] text-slate-100 shadow-2xl p-6 space-y-5">
        {loadErr ? (
          <div className="space-y-4 text-center">
            <h1 className="text-xl font-semibold text-slate-100">Invite unavailable</h1>
            <p className="text-sm text-slate-300">{loadErr}</p>
            <Link href="/dashboard" className="inline-block text-sm text-cyan-300 hover:text-cyan-200">
              Go to your dashboard
            </Link>
          </div>
        ) : !preview ? (
          <p className="text-center text-sm text-slate-400">Opening invite…</p>
        ) : (
          <>
            <div className="flex items-center gap-4">
              <GroupIcon name={preview.group.name} iconUrl={preview.group.iconUrl} size={56} />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-widest text-slate-400">You&apos;re invited to join</p>
                <h1 className="truncate text-xl font-semibold text-slate-100">{preview.group.name}</h1>
                <p className="text-xs text-slate-400">
                  {preview.group.memberCount} {preview.group.memberCount === 1 ? "member" : "members"}
                </p>
              </div>
            </div>
            {preview.group.description ? (
              <p className="text-sm text-slate-300 whitespace-pre-line break-words">{preview.group.description}</p>
            ) : null}

            {preview.alreadyMember && preview.group.id ? (
              <Link
                href={`/dashboard/groups/${encodeURIComponent(preview.group.id)}`}
                className="block w-full text-center px-4 py-2.5 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm"
              >
                You&apos;re already in this group — open it
              </Link>
            ) : preview.signedIn ? (
              <button
                type="button"
                onClick={join}
                disabled={joining}
                className="w-full px-4 py-2.5 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
              >
                {joining ? "Joining…" : "Join group"}
              </button>
            ) : (
              <div className="space-y-2">
                <Link
                  href={`/sign-in?redirect_url=${encodeURIComponent(back)}`}
                  className="block w-full text-center px-4 py-2.5 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm"
                >
                  Sign in to join
                </Link>
                <Link
                  href={`/sign-up?redirect_url=${encodeURIComponent(back)}`}
                  className="block w-full text-center px-4 py-2.5 rounded-full border border-slate-700 text-slate-200 hover:border-slate-500 transition text-sm"
                >
                  Create an account
                </Link>
              </div>
            )}

            {joinErr ? (
              <div className="text-xs text-rose-200 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                {joinErr}
              </div>
            ) : null}
            <UpgradeHint error={joinErr} />
            <p className="text-center text-xs text-slate-500">
              This link works until {new Date(preview.invite.expiresAt).toLocaleString()}.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
