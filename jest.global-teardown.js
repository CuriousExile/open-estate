const { rmSync } = require('node:fs');

/** Removes the per-run temp directory of `jest.global-setup.js` and restores TMPDIR. */
module.exports = function globalTeardown() {
  const runDir = process.env['OPEN_ESTATE_JEST_TMPDIR'];
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  const original = process.env['OPEN_ESTATE_JEST_ORIGINAL_TMPDIR'];
  if (original) process.env['TMPDIR'] = original;
  else delete process.env['TMPDIR'];
  delete process.env['OPEN_ESTATE_JEST_TMPDIR'];
  delete process.env['OPEN_ESTATE_JEST_ORIGINAL_TMPDIR'];
};
