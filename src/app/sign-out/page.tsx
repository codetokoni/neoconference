"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";

export default function SignOutPage() {
  const { signOut } = useClerk();
  const router = useRouter();
  useEffect(() => {
    (async () => {
      // Revoke the persistent device session BEFORE dropping the Clerk session —
      // /api/auth/logout needs the Clerk auth to identify the user. Without this
      // the neoconf-session cookie would survive a sign-out.
      try {
        await fetch("/api/auth/logout?scope=device", {
          method: "POST",
          credentials: "same-origin",
        });
      } catch (e) { console.error("session revoke failed", e); }
      try { await signOut(); } catch (e) { console.error("signOut failed", e); }
      try {
        if (typeof window !== "undefined") {
          for (let i = window.localStorage.length - 1; i >= 0; i--) {
            const k = window.localStorage.key(i);
            if (!k) continue;
            if (k.startsWith("clerk") || k.startsWith("__clerk")) {
              window.localStorage.removeItem(k);
            }
          }
          window.sessionStorage.clear();
        }
      } catch {}
      router.replace("/");
      setTimeout(() => {
        if (typeof window !== "undefined" && window.location.pathname !== "/") {
          window.location.href = "/";
        }
      }, 800);
    })();
  }, [signOut, router]);

  return (
    <main className="min-h-[calc(100vh-65px)] flex items-center justify-center bg-black text-cyan-300">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm tracking-wide">Signing you out…</p>
      </div>
    </main>
  );
}
