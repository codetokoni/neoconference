// src/app/api/version/route.ts
//
// GET /api/version
// What commit this deployment was built from.
//
// Exists because a green CI run and a merged PR do not prove the code is
// serving on neoconference.app. A production deployment can build and
// succeed while the alias stays pinned to an older one — Deployment
// Protection has frozen it here before — and the only symptom is that a
// fix you are certain you shipped simply does not run. That is expensive
// to debug from the outside, because every layer looks correct.
//
// scripts/check-deploy.mjs compares this against the commit you expect.
//
// Public on purpose: a check that needs credentials is a check nobody runs.
// Nothing here is sensitive — the commit SHA is already visible in a public
// repository, and the deployment id is in every page's asset URLs.

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      env: process.env.VERCEL_ENV ?? 'development',
    },
    {
      // Never cached: a cached answer would report the previous deployment
      // and defeat the entire purpose.
      headers: { 'cache-control': 'no-store, max-age=0' },
    }
  );
}
