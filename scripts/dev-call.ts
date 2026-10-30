import { fileURLToPath } from 'node:url';
import { callDev } from './lib/dev-client.ts';

async function main(): Promise<void> {
  const [target, json] = process.argv.slice(2);
  if (!target || !json) {
    console.error("usage: node scripts/dev-call.ts <target> '<json>'");
    process.exitCode = 1;
    return;
  }
  const input: unknown = JSON.parse(json);
  const result = await callDev(target, input);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
