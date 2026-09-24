#!/usr/bin/env node
// scripts/check-deploy.mjs
//
// Fails loudly when the live domain is not serving the commit you merged.
//
//   node scripts/check-deploy.mjs                 # expects local HEAD
//   node scripts/check-deploy.mjs <sha>           # expects a given commit
//   NEO_SITE=https://… node scripts/check-deploy.mjs
//
// Why this exists: a Vercel production deployment can build, pass CI and
// report success while the alias stays pinned to an older deployment.
// Deployment Protection has frozen www.neoconference.app that way before.
// Nothing errors. The only symptom is that a fix you are certain you
// shipped does not run — and since every layer looks correct, the natural
// assumption is that the code is wrong, which costs hours.
//
// Exit code 0 when the domain serves the expected commit, 1 otherwise.

import { execSync } from 'node:child_process';

const SITE = (process.env.NEO_SITE ?? 'https://www.neoconference.app').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.NEO_DEPLOY_TIMEOUT_MS ?? 180_000);
const INTERVAL_MS = 5_000;

function expectedSha() {
  const fromArg = process.argv[2];
  if (fromArg) return fromArg.trim();
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    console.error('Could not read HEAD, and no commit was given.');
    process.exit(1);
  }
}

async function readVersion() {
  const res = await fetch(`${SITE}/api/version`, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
  });
  if (!res.ok) {
    // 404 has two very different meanings here and it is worth saying both:
    // the deployment serving this domain predates the endpoint (which is
    // itself the stale-alias symptom), or the route has fallen behind the
    // auth wall, since the middleware matcher does not exclude API routes.
    throw new Error(
      `${SITE}/api/version returned HTTP ${res.status}. ` +
        (res.status === 404
          ? 'Either the live deployment predates this endpoint — which is the ' +
            'stale alias this script exists to catch — or the route is no ' +
            'longer in isPublicRoute in src/middleware.ts.'
          : 'Check whether the route is still public in src/middleware.ts.')
    );
  }
  return res.json();
}

const expected = expectedSha();
const short = (s) => (s ? String(s).slice(0, 7) : '(none)');

console.log(`Waiting for ${SITE} to serve ${short(expected)}…`);

const deadline = Date.now() + TIMEOUT_MS;
let last = null;

while (Date.now() < deadline) {
  try {
    const info = await readVersion();
    last = info;
    if (info.sha && info.sha === expected) {
      console.log(`OK: ${SITE} is serving ${short(info.sha)} (${info.deploymentId ?? 'unknown deployment'}).`);
      process.exit(0);
    }
    process.stdout.write(`  serving ${short(info.sha)}, waiting…\n`);
  } catch (err) {
    process.stdout.write(`  ${err.message}\n`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

console.error('');
console.error(`STALE DEPLOY: ${SITE} is not serving the expected commit.`);
console.error(`  expected: ${expected}`);
console.error(`  serving:  ${last?.sha ?? '(unknown)'}  ${last?.deploymentId ?? ''}`);
console.error('');
console.error('The build probably succeeded and the alias did not move. Check');
console.error('the newest production deployment and promote it:');
console.error('');
console.error('  npx vercel ls neoconference --prod');
console.error('  npx vercel promote <deployment-url>');
console.error('');
console.error('Until that is done, anything merged is not actually live, however');
console.error('green the checks look.');
process.exit(1);
