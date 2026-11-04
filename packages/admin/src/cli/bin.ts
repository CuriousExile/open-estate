#!/usr/bin/env node
// Entry of the `open-estate-admin` binary. Not re-exported from the package index, so the
// Lambda bundles never pull in the CLI (and its Lambda/credential clients).
import { runCli } from './main';

void runCli(process.argv.slice(2), {
  env: process.env,
  io: {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  },
}).then((code) => {
  process.exitCode = code;
});
