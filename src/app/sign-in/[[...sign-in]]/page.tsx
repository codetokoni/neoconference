import { SignIn } from "@clerk/nextjs";
import Link from "next/link";

export default function Page({
  searchParams,
}: {
  searchParams: { kc_error?: string };
}) {
  const err = searchParams?.kc_error;
  return (
    <div className="flex flex-col items-center py-16 gap-4">
      {err && (
        <div className="bg-red-100 text-red-800 px-4 py-2 rounded text-sm max-w-md text-center">
          KingsChat sign-in failed: {err}. Please try again or use another
          method.
        </div>
      )}
      <SignIn />
      <Link
        href="/api/auth/kingschat/start"
        className="inline-flex items-center justify-center w-72 px-4 py-2 rounded bg-[#1f8feb] hover:bg-[#1976c4] text-white font-medium transition-colors"
      >
        Continue with KingsChat
      </Link>
    </div>
  );
}
