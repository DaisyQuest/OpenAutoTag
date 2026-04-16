import { pathToFileURL } from "node:url";
import { scoreJob } from "./lib/tools.js";

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "score" && rest[0]) {
    const result = await scoreJob({ jobDir: rest[0] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write("Usage: node modules/mcp-corpus-eval/cli.js score <jobDir>\n");
    process.exitCode = 1;
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
