import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
} from "@clerk/nextjs";
import Link from "next/link";
import { getCurrentRole } from "@/lib/roles";
import HeaderUserMenu from "@/components/HeaderUserMenu";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "NeoConference — Premium HD video meetings",
  description: "Cinematic, real-time video conferencing with crystal-clear audio, recording, and zero friction.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = await getCurrentRole();
  return (
    <ClerkProvider>
      <html lang="en" className={inter.variable}>
        <body className={inter.className}>
          <header className="sticky top-0 z-40 backdrop-blur-xl bg-[rgba(4,8,16,0.55)] border-b border-white/5">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
              <Link href="/" className="group inline-flex items-center gap-2.5">
                <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-300 via-cyan-400 to-blue-500 shadow-[0_0_24px_rgba(34,211,238,0.55)]">
                  <span className="absolute inset-0 rounded-xl ring-1 ring-white/30" />
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-900" fill="currentColor" aria-hidden>
                    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h7A2.5 2.5 0 0 1 15 7.5v9A2.5 2.5 0 0 1 12.5 19h-7A2.5 2.5 0 0 1 3 16.5v-9Zm14 1.2 3.3-2a1 1 0 0 1 1.5.86v8.88a1 1 0 0 1-1.5.86L17 15.3V8.7Z" />
                  </svg>
                </span>
                <span className="font-semibold tracking-tight text-cyan-100 text-[17px]">
                  Neo<span className="neo-gradient-text">Conference</span>
                </span>
              </Link>

              <nav className="flex items-center gap-2 sm:gap-3">
                <SignedOut>
                  <SignInButton mode="modal">
                    <button className="hidden sm:inline-flex neo-btn-ghost text-sm">Sign in</button>
                  </SignInButton>
                  <SignUpButton mode="modal">
                    <button className="neo-btn text-sm">Get started</button>
                  </SignUpButton>
                </SignedOut>
                <SignedIn>
                  {role === "admin" && (
                    <Link
                      href="/admin"
                      className="hidden sm:inline-flex text-xs font-semibold px-3 py-1.5 rounded-lg bg-cyan-400/10 text-cyan-200 border border-cyan-300/30 hover:bg-cyan-400/20 transition"
                    >
                      Admin
                    </Link>
                  )}
                  <HeaderUserMenu />
                </SignedIn>
              </nav>
            </div>
          </header>

          <main className="min-h-[calc(100vh-65px)]">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}

