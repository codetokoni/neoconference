import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import {
  ClerkProvider,
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";
import { getCurrentRole } from "@/lib/roles";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NeoConference",
  description: "The next generation of virtual classrooms.",
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
      <html lang="en">
        <body className={inter.className}>
          <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-black text-cyan-400">
            <Link href="/" className="font-semibold text-lg text-cyan-400 hover:text-cyan-300">
              NeoConference
            </Link>
            <nav className="flex items-center gap-3">
              <SignedOut>
                <SignInButton mode="modal" />
                <SignUpButton mode="modal" />
              </SignedOut>
              <SignedIn>
                {role === "admin" && (<Link href="/admin" className="text-xs px-2 py-1 rounded bg-cyan-400 text-black font-semibold hover:bg-cyan-300">Admin</Link>)}
              <UserButton afterSignOutUrl="/" />
              </SignedIn>
            </nav>
          </header>
          <main className="min-h-[calc(100vh-65px)]">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
