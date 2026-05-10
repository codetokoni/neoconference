"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import HeaderUserMenu from "./HeaderUserMenu";

/**
 * Client-side header nav. Renders Sign in / Get started when the user is
 * unauthenticated, and the Admin link (if applicable) + user avatar menu
 * when the user is signed in.
 *
 * Reads useUser() so the rendered state always tracks the live Clerk
 * session — avoids the SSR/CSR mismatch that occurred when this branch was
 * driven by <SignedIn> / <SignedOut> server components.
 *
 * The role prop is resolved server-side in the layout (via getCurrentRole)
 * and is only consulted while signed in, so it does not affect the
 * unauthenticated render path.
 */
export default function HeaderNav({ role }: { role?: string | null }) {
  const { isLoaded, isSignedIn } = useUser();

  return (
    <nav className="flex items-center gap-2 sm:gap-3">
      <Link
        href="/pricing"
        className="hidden sm:inline-flex text-xs font-medium px-3 py-1.5 rounded-lg text-cyan-100/80 hover:text-white hover:bg-white/5 transition"
      >
        Pricing
      </Link>

      {!isLoaded ? (
        // Reserve space while Clerk hydrates so we don't flash an empty header.
        <div aria-hidden className="w-9 h-9" />
      ) : isSignedIn ? (
        <>
          {role === "admin" && (
            <Link
              href="/admin"
              className="hidden sm:inline-flex text-xs font-semibold px-3 py-1.5 rounded-lg bg-cyan-400/10 text-cyan-200 border border-cyan-300/30 hover:bg-cyan-400/20 transition"
            >
              Admin
            </Link>
          )}
          <HeaderUserMenu />
        </>
      ) : (
        <>
          <Link href="/sign-in" className="hidden sm:inline-flex neo-btn-ghost text-sm">
            Sign in
          </Link>
          <Link href="/sign-up" className="neo-btn text-sm">
            Get started
          </Link>
        </>
      )}
    </nav>
  );
}
