import { agencyScope } from '@open-estate/core';
import { CreateListingRequest, lookupKeys } from '@open-estate/shared';
import { duplicatePlatform, member } from '../../core/test/duplicates/support/duplicate-harness';
import {
  crowdBodies,
  DEFAULT_CROWD_SIZE,
  isolatedBodies,
  probeBodies,
  requiredSegmentRate,
} from '../src/duplicate-load';

// Bodies of the duplicate load test (duplicate-detection task 13.3): the crowd gives every probe
// at least `maxCandidates` (200) candidates without any duplicate; isolated creations meet none.

describe('duplicate load test bodies', () => {
  it('are valid, deterministic creations', () => {
    for (const body of [...crowdBodies(5), ...probeBodies(5), ...isolatedBodies(5)]) {
      expect(CreateListingRequest.safeParse(body).success).toBe(true);
    }
    expect(crowdBodies(3)).toEqual(crowdBodies(3));
  });

  it('give each probe the full candidate limit and flag nothing', async () => {
    const platform = duplicatePlatform();
    const agent = member('agy-a');
    for (const body of crowdBodies(DEFAULT_CROWD_SIZE)) {
      const created = await platform.commands.create(agent, body);
      expect(created.ok && created.value.flags).toEqual([]);
    }
    const [probe] = probeBodies(1);
    const created = await platform.commands.create(agent, probe);
    expect(created.ok && created.value.flags).toEqual([]);
    const id = created.ok ? created.value.id : '';
    const stored = await platform.get(id);
    if (stored === null) throw new Error('probe missing');
    // The probe as the Duplikat_Prüfung saw it (itself excluded).
    const assessment = await platform.detector.assess({
      listingId: id,
      scope: agencyScope('agy-a'),
      createdAt: '2026-03-01T12:00:00.000Z',
      content: stored.listing,
    });
    expect(assessment.truncated).toBe(true);
    expect(assessment.matches).toEqual([]);
    const candidates = await platform.index.candidates(
      lookupKeys(assessment.profile, platform.config),
      agencyScope('agy-a'),
    );
    expect(new Set(candidates.map((c) => c.listingId)).size).toBeGreaterThanOrEqual(
      platform.config.maxCandidates,
    );

    const [lonely] = isolatedBodies(1);
    const alone = await platform.commands.create(agent, lonely);
    const view = alone.ok ? await platform.get(alone.value.id) : null;
    if (view === null) throw new Error('isolated missing');
    const none = await platform.detector.assess({
      listingId: view.listing.id,
      scope: agencyScope('agy-a'),
      createdAt: '2026-03-01T12:00:00.000Z',
      content: view.listing,
    });
    const isolated = await platform.index.candidates(
      lookupKeys(none.profile, platform.config),
      agencyScope('agy-a'),
    );
    // Only its own block entries.
    expect(new Set(isolated.map((c) => c.listingId))).toEqual(new Set([view.listing.id]));
  });

  it('names the throughput a segment needs for 1,000,000 listings in 4 hours (Req 10.9)', () => {
    expect(requiredSegmentRate(1_000_000, 8, 4)).toBeCloseTo(26.04, 2);
  });
});
