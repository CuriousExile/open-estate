import fc from 'fast-check';

// Global fast-check defaults for all property tests (design: numRuns 100).
fc.configureGlobal({ numRuns: 100 });

// Powertools writes straight to stdout/stderr (not the Jest console): keep the module-scope
// Lambda loggers and EMF metrics quiet. Tests that assert output spy on `logger` or build their
// own Logger/Metrics with explicit options.
process.env['POWERTOOLS_LOG_LEVEL'] ??= 'SILENT';
process.env['POWERTOOLS_METRICS_DISABLED'] ??= 'true';
