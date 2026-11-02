import { main } from './cli.ts';

// Entry of server/dist/audit.mjs (see cli.ts for the commands).
const { result, code } = await main(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = code;
