// Feature: duplicate-detection, Property 16: Idempotenzschlüssel
import fc from 'fast-check';
import { duplicatePlatform, machine, member } from './support/duplicate-harness';

/**
 * For any sequence of creation requests by several actors with arbitrary keys, bodies and a
 * simulated clock: per actor, key and 24-hour window at most one listing is created; every
 * repetition with the same body answers with that listing (`replayed`); another body is refused
 * with 409 `IDEMPOTENCY_KEY_REUSED` without any change; an invalid key is refused with 400; keys
 * of different actors do not affect each other; after 24 hours the key is free again.
 *
 * The answer header `Idempotent-Replayed` is set by the route from `replayed` (task 9.1).
 *
 * **Validates: Requirements 9.2, 9.3, 9.4, 9.5, 9.6**
 */

const ACTORS = [member('agy-a', 'usr-1'), member('agy-a', 'usr-2'), machine('agy-a')];
const KEYS = ['crm-1', 'crm-2', 'has space', ''];
const DAY_MS = 24 * 60 * 60 * 1000;

const body = (n: number) => ({
  content: {
    originalLocale: 'de',
    title: `Wohnung ${n}`,
    description: '',
    translations: [],
    offers: [{ offerType: 'SALE', price: `${100000 + n}.00`, currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 2,
    area: `${50 + n}.00`,
    address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: `Weg ${n}` },
    media: [],
    tours: [],
  },
});

const arbRequest = fc.record({
  actor: fc.nat({ max: ACTORS.length - 1 }),
  key: fc.nat({ max: KEYS.length - 1 }),
  body: fc.nat({ max: 2 }),
  /** Jump past the 24-hour window before the request. */
  laterDay: fc.boolean(),
});

describe('Property 16: Idempotenzschlüssel', () => {
  it('creates at most one listing per actor, key and window and replays repetitions', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(arbRequest, { minLength: 1, maxLength: 12 }), async (requests) => {
        const platform = duplicatePlatform();
        /** Reference model: actor|key → listing and body of the binding request. */
        const bound = new Map<string, { listingId: string; body: number }>();

        for (const request of requests) {
          if (request.laterDay) {
            platform.advance(DAY_MS + 1000);
            bound.clear();
          }
          const key = KEYS[request.key] ?? '';
          const actor = ACTORS[request.actor];
          if (actor === undefined) throw new Error('actor');
          const before = platform.listings.all().length;
          const result = await platform.commands.createWithKey(actor, body(request.body), key);
          const after = platform.listings.all().length;

          if (!/^[\x21-\x7E]{1,128}$/.test(key)) {
            expect(!result.ok && result.error[0]).toMatchObject({
              code: 'INVALID_PARAMETER',
              field: 'Idempotency-Key',
            });
            expect(after).toBe(before);
            continue;
          }
          const slot = `${request.actor}|${key}`;
          const binding = bound.get(slot);
          if (binding === undefined) {
            expect(result.ok && result.value.replayed).toBe(false);
            expect(after).toBe(before + 1);
            if (result.ok) bound.set(slot, { listingId: result.value.view.id, body: request.body });
          } else if (binding.body === request.body) {
            expect(result.ok && result.value).toMatchObject({
              replayed: true,
              view: { id: binding.listingId },
            });
            expect(after).toBe(before);
          } else {
            expect(!result.ok && result.error[0]?.code).toBe('IDEMPOTENCY_KEY_REUSED');
            expect(after).toBe(before);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
