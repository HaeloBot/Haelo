#!/usr/bin/env node
import { run } from "./cli-main.js";

const code = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
});
process.exit(code);
