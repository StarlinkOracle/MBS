import { runMasterAgent } from './master-agent.js';
import { startCommsAgent } from './comms-agent.js';

function readArg(flag: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];

  if (command === 'master-agent') {
    const goal = readArg('--goal') ?? 'Default service optimization goal';
    const orgSlug = readArg('--org');

    const result = await runMasterAgent({ goal, orgSlug });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'comms-agent') {
    const orgSlug = readArg('--org');
    await startCommsAgent({ orgSlug });
    return;
  }

  console.log('Usage: npx tsx src/index.ts master-agent --goal "..." [--org slug]');
  console.log('   or: npx tsx src/index.ts comms-agent [--org slug]');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
