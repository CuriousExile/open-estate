// Feature: duplicate-detection, Property 13: Änderungen und Status
import { contentToInput, type ManagedListing } from '@open-estate/core';
import { duplicateFlagOf } from '@open-estate/shared';
import fc from 'fast-check';
import {
  applyOperation,
  arbContentPool,
  duplicatePlatform,
  member,
  platformAdmin,
  type DuplicatePlatform,
  type Operation,
} from './support/duplicate-harness';

/**
 * For any sequence of edits, restores, agency assignments and Abgleiche, the Listing_Status of
 * every listing afterwards equals its status before; and changes of only the status or only the
 * Custom_Id (except the release of a flagged listing) leave all Markierungen unchanged. Imports
 * are covered by Property 23.
 *
 * **Validates: Requirements 6.2, 6.4, 10.3, 11.2**
 */

type Step =
  | { kind: 'write'; operation: Extract<Operation, { kind: 'edit' | 'restore' | 'assign' }> }
  | { kind: 'sweep' }
  | { kind: 'customId'; listing: number; value: number }
  | { kind: 'status'; listing: number; status: 'ACTIVE' | 'INACTIVE' };

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  fc
    .oneof(
      fc.record({ kind: fc.constant('edit' as const), listing: fc.nat(), content: fc.nat() }),
      fc.record({ kind: fc.constant('restore' as const), listing: fc.nat() }),
      fc.record({ kind: fc.constant('assign' as const), listing: fc.nat(), agency: fc.nat() }),
    )
    .map((operation) => ({ kind: 'write' as const, operation })),
  fc.constant({ kind: 'sweep' as const }),
  fc.record({ kind: fc.constant('customId' as const), listing: fc.nat(), value: fc.nat(99) }),
  fc.record({
    kind: fc.constant('status' as const),
    listing: fc.nat(),
    status: fc.constantFrom('ACTIVE' as const, 'INACTIVE' as const),
  }),
);

const snapshot = async (platform: DuplicatePlatform) =>
  new Map(
    (await platform.all()).map((l) => [
      l.listing.id,
      { status: l.management.status, flags: l.management.flags ?? [] },
    ]),
  );

const actorOf = (listing: ManagedListing) =>
  listing.management.agencyId === undefined ? platformAdmin : member(listing.management.agencyId);

describe('Property 13: Änderungen und Status', () => {
  it('never changes a status by a check, and never a Markierung by status or Custom_Id', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbContentPool,
        fc.array(
          fc.record({
            agency: fc.nat(),
            content: fc.nat(),
            status: fc.constantFrom('ACTIVE' as const, 'INACTIVE' as const),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(arbStep, { minLength: 1, maxLength: 10 }),
        async (pool, creations, steps) => {
          const platform = duplicatePlatform();
          for (const creation of creations) {
            await applyOperation(platform, pool, { kind: 'create', ...creation });
          }
          for (const step of steps) {
            const before = await snapshot(platform);
            const ids = [...before.keys()].sort();
            const pick = (n: number) => ids[n % ids.length] ?? '';
            switch (step.kind) {
              case 'write':
                await applyOperation(platform, pool, step.operation);
                break;
              case 'sweep':
                await platform.sweep();
                break;
              case 'customId': {
                const current = await platform.get(pick(step.listing));
                if (current === null) break;
                await platform.commands.replaceContent(actorOf(current), current.listing.id, {
                  content: contentToInput(current.listing),
                  customId: `crm-${step.value}`,
                  baseVersion: current.management.version,
                });
                break;
              }
              case 'status': {
                const current = await platform.get(pick(step.listing));
                if (current === null) break;
                // Activating a flagged listing is the release (Property 14).
                const release =
                  step.status === 'ACTIVE' &&
                  duplicateFlagOf(current.management.flags ?? []) !== undefined;
                if (release) break;
                await platform.commands.setStatus(actorOf(current), current.listing.id, {
                  status: step.status,
                });
                break;
              }
            }
            const after = await snapshot(platform);
            for (const [id, state] of after) {
              const previous = before.get(id);
              if (previous === undefined) continue;
              if (step.kind === 'status' && id === pick(step.listing)) {
                expect(state.flags).toEqual(previous.flags);
                continue;
              }
              // Nothing but an explicit status change changes a status (Req 6.2, 10.3, 11.2).
              expect(state.status).toBe(previous.status);
              if (step.kind === 'customId' || step.kind === 'status') {
                expect(state.flags).toEqual(previous.flags);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
