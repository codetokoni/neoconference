// agents/captions-worker/src/index.ts
//
// Worker bootstrap. The framework dynamically imports `agent.js` in spawned
// child processes; this file only runs cli.runApp in the parent process.

import { config as loadEnv } from 'dotenv';
import { cli, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));

cli.runApp(
  new WorkerOptions({
      agent: join(__dirname, 'agent.js'),
          agentName: process.env.AGENT_NAME ?? 'neo-captions',
            }),
            );
            