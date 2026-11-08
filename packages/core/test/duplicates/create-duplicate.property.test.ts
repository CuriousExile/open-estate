// Feature: duplicate-detection, Property 12: Anlage eines Duplikats
import { duplicateFlagOf } from '@open-estate/shared';
import fc from 'fast-check';
import {
  AGENCY_IDS,
  applyOperation,
  arbContentPool,
  duplicatePlatform,
  expectedOriginal,
  machine,
  member,
  platformAdmin,
} from './support/duplicate-harness';

/**
 * For any stock and any creation request — through a portal user, a machine access or a
 * Plattform_Admin, with any requested status — the new listing is stored `INACTIVE` with a
 * Duplikat_Markierung (`detectedBy: CREATE`) and the Statusbegründung `DUPLICATE` with the
 * Original in version 1 exactly when it is a duplicate (reference model of Req 4); the answer is
 * a success with that state. Otherwise it is stored as requested, without Markierung and without
 * Statusbegründung, as before this feature.
 *
 * **Validates: Requirements 5.2, 5.3, 5.4, 5.6**
 */

const arbChannel = fc.constantFrom('portal', 'machine', 'admin');

describe('Property 12: Anlage eines Duplikats', () => {
  it('stores a duplicate INACTIVE and flagged, everything else as requested', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 6 }),
        fc.record({
          agency: fc.nat(),
          content: fc.nat(),
          status: fc.constantFrom('ACTIVE' as const, 'INACTIVE' as const, undefined),
          channel: arbChannel,
        }),
        async (pool, stock, request) => {
          const platform = duplicatePlatform();
          for (const [agency, content] of stock) {
            await applyOperation(platform, pool, {
              kind: 'create',
              agency,
              content,
              status: 'ACTIVE',
            });
          }
          const agencyId = AGENCY_IDS[request.agency % AGENCY_IDS.length] ?? 'agy-a';
          const principal =
            request.channel === 'portal'
              ? member(agencyId)
              : request.channel === 'machine'
                ? machine(agencyId)
                : platformAdmin;
          const body = {
            content: pool[request.content % pool.length],
            ...(request.status !== undefined && { status: request.status }),
            ...(request.channel === 'admin' && { agencyId }),
          };

          const result = await platform.commands.create(principal, body);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const stored = await platform.get(result.value.id);
          if (stored === null) throw new Error('created listing missing');
          const original = await expectedOriginal(platform, stored);
          const v1 = await platform.versions.get(result.value.id, 1);

          if (original !== null) {
            expect(result.value.status).toBe('INACTIVE');
            expect(duplicateFlagOf(result.value.flags)).toMatchObject({
              detectedBy: 'CREATE',
              originalId: original,
            });
            expect(v1?.status).toBe('INACTIVE');
            expect(v1?.statusReason).toEqual({ code: 'DUPLICATE', originalId: original });
          } else {
            expect(result.value.status).toBe(request.status ?? 'INACTIVE');
            expect(result.value.flags).toEqual([]);
            expect(v1?.statusReason).toBeUndefined();
          }
          // The answer is the stored state.
          expect(result.value.status).toBe(stored.management.status);
          expect(result.value.flags).toEqual(stored.management.flags ?? []);
        },
      ),
      { numRuns: 100 },
    );
  });
});
