import { createRunLogger } from '@open-estate/ingestion';

const NOW = new Date('2026-11-05T10:00:00.000Z');

function setup() {
  const lines: string[] = [];
  const logger = createRunLogger({
    runId: 'run-1',
    source: 'partner-db',
    sink: (line) => lines.push(line),
    now: () => NOW,
  });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, entries };
}

describe('RunLogger', () => {
  it('writes one JSON line per event with run id, source and timestamp', () => {
    const { logger, lines, entries } = setup();
    logger.runStarted('relational-db');
    logger.runFinished({
      status: 'SUCCESS',
      startedAt: NOW,
      endedAt: new Date('2026-11-05T10:01:00.000Z'),
      imported: 3,
      updated: 1,
      unchanged: 4,
      rejected: 2,
      flagged: 1,
    });
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    expect(entries()).toEqual([
      {
        timestamp: NOW.toISOString(),
        level: 'info',
        event: 'run.started',
        runId: 'run-1',
        source: 'partner-db',
        connectorType: 'relational-db',
      },
      {
        timestamp: NOW.toISOString(),
        level: 'info',
        event: 'run.finished',
        runId: 'run-1',
        source: 'partner-db',
        status: 'SUCCESS',
        startedAt: '2026-11-05T10:00:00.000Z',
        endedAt: '2026-11-05T10:01:00.000Z',
        imported: 3,
        updated: 1,
        unchanged: 4,
        rejected: 2,
        flagged: 1,
      },
    ]);
  });

  it('logs drops and rejections with ids, field names and reasons only', () => {
    const { logger, entries } = setup();
    logger.piiFieldDropped('L-1', 'contact.email');
    logger.recordRejected('L-2', [
      { field: 'offers.0.price', reason: 'Too small: expected number to be >=0.01' },
      { field: 'address.city', reason: 'Required' },
    ]);
    logger.recordRejected(undefined, [{ field: 'id', reason: 'Required' }]);
    logger.mediaDropped('L-3', 'tour', 4, 'host not on tour allow-list');
    logger.configRejected([{ field: 'settings.query', reason: 'Required' }]);
    logger.connectorError('timeout');
    logger.runSkipped('connector is disabled');

    const all = entries();
    expect(all.every((e) => e['runId'] === 'run-1' && e['source'] === 'partner-db')).toBe(true);
    const withoutCommon = all.map((e) => {
      const rest = { ...e };
      delete rest['timestamp'];
      delete rest['runId'];
      delete rest['source'];
      return rest;
    });
    expect(withoutCommon).toEqual([
      { level: 'info', event: 'pii.field_dropped', listingId: 'L-1', field: 'contact.email' },
      {
        level: 'warn',
        event: 'record.rejected',
        listingId: 'L-2',
        issues: [
          { field: 'offers.0.price', reason: 'Too small: expected number to be >=0.01' },
          { field: 'address.city', reason: 'Required' },
        ],
      },
      { level: 'warn', event: 'record.rejected', issues: [{ field: 'id', reason: 'Required' }] },
      {
        level: 'warn',
        event: 'media.dropped',
        listingId: 'L-3',
        kind: 'tour',
        index: 4,
        reason: 'host not on tour allow-list',
      },
      {
        level: 'error',
        event: 'config.rejected',
        issues: [{ field: 'settings.query', reason: 'Required' }],
      },
      { level: 'error', event: 'connector.error', reason: 'timeout' },
      { level: 'info', event: 'run.skipped', reason: 'connector is disabled' },
    ]);
  });

  it('never writes keys beyond the declared ones, even if callers pass extra properties', () => {
    const { logger, lines } = setup();
    const secret = 'max.mustermann@example.org';
    const issue = { field: 'contact.email', reason: 'Invalid email', value: secret };
    logger.recordRejected('L-1', [issue]);
    logger.runFinished({
      status: 'FAILURE',
      startedAt: NOW,
      endedAt: NOW,
      imported: 0,
      updated: 0,
      unchanged: 0,
      rejected: 1,
      flagged: 0,
      ...{ record: { contact: { email: secret } } },
    });
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('"value"');
  });

  it('logs the URL of dropped tours only, and truncation counts', () => {
    const { logger, entries } = setup();
    logger.mediaDropped('L-1', 'tour', 0, 'host', 'https://evil.example/t');
    logger.mediaDropped('L-1', 'media', 1, 'scheme', 'http://img.example/1.jpg');
    logger.mediaTruncated('L-1', 'media', 3);
    const [tour, media, truncated] = entries();
    expect(tour?.['url']).toBe('https://evil.example/t');
    expect(media).not.toHaveProperty('url');
    expect(truncated).toMatchObject({ event: 'media.truncated', kind: 'media', droppedCount: 3 });
  });

  it('clips long free text', () => {
    const { logger, entries } = setup();
    logger.connectorError('x'.repeat(1000));
    expect(String(entries()[0]?.['reason']).length).toBeLessThanOrEqual(201);
  });

  it('defaults to stdout', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createRunLogger({ runId: 'r', source: 's' }).connectorError('boom');
      expect(write).toHaveBeenCalledWith(
        expect.stringMatching(/^\{.*"event":"connector.error".*\}\n$/),
      );
    } finally {
      write.mockRestore();
    }
  });
});
