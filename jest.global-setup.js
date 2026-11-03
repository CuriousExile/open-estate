const { mkdtempSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

/**
 * Points TMPDIR at a directory per Jest run, removed again by `jest.global-teardown.js`. CDK apps
 * without an explicit `outdir` synthesize into `os.tmpdir()/cdk.out*` and never clean up; the
 * workers are started after this hook and inherit the variable.
 */
module.exports = function globalSetup() {
  const runDir = mkdtempSync(path.join(realpathSync(tmpdir()), 'open-estate-jest-'));
  process.env['OPEN_ESTATE_JEST_ORIGINAL_TMPDIR'] = process.env['TMPDIR'] ?? '';
  process.env['OPEN_ESTATE_JEST_TMPDIR'] = runDir;
  process.env['TMPDIR'] = runDir;
};
