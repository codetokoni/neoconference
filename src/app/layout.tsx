import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";
import { getCurrentRole } from "@/lib/roles";
import HeaderNav from "@/components/HeaderNav";
import NeoMark from "@/components/NeoMark";
import SupportWidget from "@/components/SupportWidget";
import AndroidAppGate from "@/components/AndroidAppGate";
import SessionBootstrap from "@/components/SessionBootstrap";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "NeoConference — Video meetings with live translation",
  description:
    "Video meetings where everyone hears each speaker in their own language, translated live. On the web and in the Android app.",
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
                {/* The app icon's tile: its gradient, the mark half its width. */}
                <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#A5FBF9_0%,#56D2FB_50%,#1F66FB_100%)] shadow-[0_0_24px_rgba(34,211,238,0.55)]">
                  <span className="absolute inset-0 rounded-xl ring-1 ring-white/30" />
                  <NeoMark className="w-4" />
                </span>
                <span className="font-semibold tracking-tight text-cyan-100 text-[17px]">
                  Neo<span className="neo-gradient-text">Conference</span>
                </span>
              </Link>

              <HeaderNav role={role} />
            </div>
          </header>

          <main className="min-h-[calc(100vh-65px)]">{children}</main>
          <SessionBootstrap />
          <SupportWidget />
          {/* Android phones get the app, not the website. */}
          <AndroidAppGate />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
