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
import PushRegistrar from "@/components/notifications/PushRegistrar";
import IncomingCall from "@/components/notifications/IncomingCall";
import PlatformNotice from "@/components/PlatformNotice";
import { getPlatformSettings } from "@/lib/platform/settings";
import { DEFAULT_PLATFORM_NAME, noticeActive } from "@/lib/platform/model";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "NeoConference — Video meetings with live translation",
  description:
    "Video meetings where everyone hears each speaker in their own language, translated live. On the web and in the Android app.",
  // Added to an iPhone's Home Screen it opens as an app — which is the only
  // way iOS delivers call alerts (Web Push) to a website.
  appleWebApp: { capable: true, title: "NeoConference", statusBarStyle: "black-translucent" },
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const role = await getCurrentRole();
  // Admin settings (KV, cached a few seconds): name, logo, banner, language.
  const settings = await getPlatformSettings();
  const { branding } = settings;
  const customName = branding.platformName !== DEFAULT_PLATFORM_NAME;
  return (
    <ClerkProvider>
      <html lang={settings.regional.defaultLanguage || "en"} className={inter.variable}>
        <body className={inter.className}>
          {noticeActive(settings.notice) && <PlatformNotice notice={settings.notice} />}
          <header className="sticky top-0 z-40 backdrop-blur-xl bg-[rgba(4,8,16,0.55)] border-b border-white/5">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex items-center justify-between">
              <Link href="/" className="group inline-flex items-center gap-2.5">
                {branding.logoKey ? (
                  // eslint-disable-next-line @next/next/no-img-element -- served by our own route from R2; next/image would need the R2 host configured
                  <img src={`/api/platform/logo?v=${branding.logoVersion}`} alt="" className="h-8 w-8 rounded-xl object-contain" />
                ) : (
                  /* The app icon's tile: its gradient, the mark half its width. */
                  <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#A5FBF9_0%,#56D2FB_50%,#1F66FB_100%)] shadow-[0_0_24px_rgba(34,211,238,0.55)]">
                    <span className="absolute inset-0 rounded-xl ring-1 ring-white/30" />
                    <NeoMark className="w-4" />
                  </span>
                )}
                <span className="font-semibold tracking-tight text-cyan-100 text-[17px]">
                  {customName ? branding.platformName : <>Neo<span className="neo-gradient-text">Conference</span></>}
                </span>
              </Link>

              <HeaderNav role={role} />
            </div>
          </header>

          <main className="min-h-[calc(100vh-65px)]">{children}</main>
          <SessionBootstrap />
          <PushRegistrar />
          <IncomingCall />
          <SupportWidget />
          {/* Android phones get the app, not the website. */}
          <AndroidAppGate />
          <SpeedInsights />
        </body>
      </html>
    </ClerkProvider>
  );
}
