import { hostOf, normalizeCity, toSearchDocument } from '@open-estate/core';
import { exampleListing } from '../../../shared/test/arbitraries';

describe('toSearchDocument', () => {
  it('derives the flat fields of a SALE listing', () => {
    const doc = toSearchDocument(
      exampleListing('a', {
        offers: [{ offerType: 'SALE', price: 350_000_00, currency: 'EUR' }],
        rooms: 2.5,
        area: 64_50,
        address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
        listingType: 'apartment_unit',
      }),
    );
    expect(doc).toEqual({
      id: 'a',
      cityNorm: 'berlin',
      postalCode: '10115',
      country: 'DE',
      listingType: 'apartment_unit',
      saleAmountMinor: 350_000_00,
      saleCurrency: 'EUR',
      roomsHalf: 5,
      areaMinor: 64_50,
      tourHosts: [],
    });
  });

  it('uses the cold rent of a RENT offer and leaves the sale fields unset', () => {
    const doc = toSearchDocument(
      exampleListing('r', {
        offers: [{ offerType: 'RENT', coldRent: 1_200_00, currency: 'CHF', warmRent: 1_500_00 }],
      }),
    );
    expect(doc).toMatchObject({ rentAmountMinor: 1_200_00, rentCurrency: 'CHF' });
    expect(doc).not.toHaveProperty('saleAmountMinor');
    expect(doc).not.toHaveProperty('saleCurrency');
  });

  it('fills both field pairs for a SALE + RENT listing', () => {
    const doc = toSearchDocument(
      exampleListing('b', {
        offers: [
          { offerType: 'RENT', coldRent: 900_00, currency: 'EUR' },
          { offerType: 'SALE', price: 250_000_00, currency: 'USD' },
        ],
      }),
    );
    expect(doc).toMatchObject({
      saleAmountMinor: 250_000_00,
      saleCurrency: 'USD',
      rentAmountMinor: 900_00,
      rentCurrency: 'EUR',
    });
  });

  it('normalizes Unicode city names to NFC lowercase', () => {
    const decomposed = 'Mu\u0308NCHEN'; // "MüNCHEN" with combining diaeresis
    const doc = toSearchDocument(
      exampleListing('u', { address: { city: decomposed, postalCode: '80331', country: 'DE' } }),
    );
    expect(doc.cityNorm).toBe('m\u00fcnchen');
    expect(normalizeCity('MÜNCHEN')).toBe(doc.cityNorm);
    expect(normalizeCity('İstanbul')).toBe(normalizeCity('i̇stanbul'));
  });

  it('collects distinct lowercase, sorted tour hosts', () => {
    const doc = toSearchDocument(
      exampleListing('t', {
        tours: [
          { url: 'https://My.Matterport.com/show/?m=1', providerCode: 'matterport' },
          { url: 'https://tours.example/x', providerCode: 'example' },
          { url: 'https://my.matterport.com/show/?m=2', providerCode: 'matterport' },
        ],
      }),
    );
    expect(doc.tourHosts).toEqual(['my.matterport.com', 'tours.example']);
  });

  it('hostOf returns undefined for unparseable URLs', () => {
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf('https://EXAMPLE.org/a')).toBe('example.org');
  });
});
