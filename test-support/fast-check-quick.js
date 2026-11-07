// Quick test tier only (see jest.config.js): stands in for `fast-check` and caps the number of
// runs of every `fc.assert` at OPEN_ESTATE_QUICK_RUNS (default 10). Property tests keep their
// shape and still catch most regressions; the full 100+ runs of the design happen in
// `npm run test:full`. Everything except `assert` is the real library.
const real = require(process.env['OPEN_ESTATE_FAST_CHECK_PATH']);

const cap = Number(process.env['OPEN_ESTATE_QUICK_RUNS'] ?? '10');

function assert(property, params) {
  const configured = params?.numRuns ?? real.readConfigureGlobal()?.numRuns ?? 100;
  return real.assert(property, { ...params, numRuns: Math.min(configured, cap) });
}

module.exports = { ...real, assert, default: { ...real.default, assert }, __esModule: true };
