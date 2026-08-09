#!/usr/bin/env node
import { main } from "../src/cli.js";

main().catch((error) => {
  process.stderr.write(`nexara: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
