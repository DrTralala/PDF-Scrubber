#!/usr/bin/env node

import { run } from '../lib/run.js';

run(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
