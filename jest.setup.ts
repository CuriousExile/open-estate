import fc from 'fast-check';

// Global fast-check defaults for all property tests (design: numRuns 100).
// Replay a reported failure: copy `seed` and `path` from the "Property failed" message, e.g.
//   OPEN_ESTATE_FC_SEED=1776548573 OPEN_ESTATE_FC_PATH="69:0:1" npm run test:full -- <file>
// Applies to every property test of the run, so restrict the run to the failing file.
const replaySeed = process.env['OPEN_ESTATE_FC_SEED'];
const replayPath = process.env['OPEN_ESTATE_FC_PATH'];
fc.configureGlobal({
  numRuns: 100,
  ...(replaySeed !== undefined && replaySeed !== '' && { seed: Number(replaySeed) }),
  ...(replayPath !== undefined && replayPath !== '' && { path: replayPath }),
});

// Powertools writes straight to stdout/stderr (not the Jest console): keep the module-scope
// Lambda loggers and EMF metrics quiet. Tests that assert output spy on `logger` or build their
// own Logger/Metrics with explicit options.
process.env['POWERTOOLS_LOG_LEVEL'] ??= 'SILENT';
process.env['POWERTOOLS_METRICS_DISABLED'] ??= 'true';
