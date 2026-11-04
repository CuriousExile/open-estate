import {
  createTourRejectionReporter,
  decideTourEmbed,
  planTourEmbeds,
  toAllowedTourHosts,
  type TourRejectionLogger,
} from '../src/app/listing/tour-embed-model';
import { parseSearchMeta } from '../src/app/search/search-meta';

const ALLOWED = toAllowedTourHosts(['my.matterport.com', 'xn--bcher-kva.example']);

describe('toAllowedTourHosts', () => {
  it('lower-cases hosts and drops entries that are not bare host names', () => {
    const hosts = toAllowedTourHosts([
      'My.Matterport.COM',
      'https://evil.example',
      'evil.example:8443',
      '*.wild.example',
      'user@evil.example',
      'evil.example/path',
    ]);
    expect([...hosts]).toEqual(['my.matterport.com']);
  });

  it('is empty without /meta, so nothing is embedded (default-deny)', () => {
    expect(toAllowedTourHosts(undefined).size).toBe(0);
    expect(decideTourEmbed('https://my.matterport.com/show/?m=1', new Set()).embed).toBe(false);
  });

  it('takes tourProviders from /meta', () => {
    const meta = parseSearchMeta({ tourProviders: ['my.matterport.com'] });
    expect([...toAllowedTourHosts(meta.tourProviders)]).toEqual(['my.matterport.com']);
  });
});

describe('decideTourEmbed (Req 16.6, 16.7)', () => {
  it('embeds an https URL on an allowed host with its normalized href', () => {
    expect(decideTourEmbed('https://MY.Matterport.com/show/?m=abc', ALLOWED)).toEqual({
      embed: true,
      url: 'https://my.matterport.com/show/?m=abc',
      host: 'my.matterport.com',
    });
  });

  it('accepts the explicit default port 443', () => {
    expect(decideTourEmbed('https://my.matterport.com:443/show', ALLOWED).embed).toBe(true);
  });

  it('matches IDN hosts in punycode form', () => {
    expect(decideTourEmbed('https://bücher.example/tour', ALLOWED)).toMatchObject({
      embed: true,
      host: 'xn--bcher-kva.example',
    });
  });

  it.each([
    ['not a URL', 'INVALID_URL', null],
    ['/relative/tour', 'INVALID_URL', null],
    ['http://my.matterport.com/show', 'NOT_HTTPS', 'my.matterport.com'],
    ['javascript:alert(1)', 'NOT_HTTPS', ''],
    ['data:text/html,<p>x</p>', 'NOT_HTTPS', ''],
    ['https://user:pw@my.matterport.com/show', 'USERINFO', 'my.matterport.com'],
    ['https://user@my.matterport.com/show', 'USERINFO', 'my.matterport.com'],
    ['https://my.matterport.com:8443/show', 'PORT', 'my.matterport.com:8443'],
    ['https://evil.example/show', 'HOST_NOT_ALLOWED', 'evil.example'],
    ['https://sub.my.matterport.com/show', 'HOST_NOT_ALLOWED', 'sub.my.matterport.com'],
    ['https://matterport.com/show', 'HOST_NOT_ALLOWED', 'matterport.com'],
    ['https://my.matterport.com./show', 'HOST_NOT_ALLOWED', 'my.matterport.com.'],
    [
      'https://my.matterport.com.evil.example/',
      'HOST_NOT_ALLOWED',
      'my.matterport.com.evil.example',
    ],
    ['https://evil.example/?u=https://my.matterport.com', 'HOST_NOT_ALLOWED', 'evil.example'],
    ['https://evil.example#@my.matterport.com', 'HOST_NOT_ALLOWED', 'evil.example'],
  ])('rejects %s (%s)', (url, reason, host) => {
    expect(decideTourEmbed(url, ALLOWED)).toEqual({ embed: false, reason, host });
  });
});

describe('planTourEmbeds', () => {
  it('embeds allowed tours in stored order and lists the rest as rejections', () => {
    const plan = planTourEmbeds(
      'l-1',
      [
        { url: 'https://my.matterport.com/show/?m=1', providerCode: 'matterport' },
        { url: 'https://evil.example/tour', providerCode: 'other' },
        { url: 'https://my.matterport.com/show/?m=2', providerCode: 'matterport' },
      ],
      ALLOWED,
    );
    expect(plan.embeds).toEqual([
      { index: 0, url: 'https://my.matterport.com/show/?m=1', providerCode: 'matterport' },
      { index: 2, url: 'https://my.matterport.com/show/?m=2', providerCode: 'matterport' },
    ]);
    expect(plan.rejections).toEqual([
      { listingId: 'l-1', host: 'evil.example', reason: 'HOST_NOT_ALLOWED' },
    ]);
  });
});

describe('createTourRejectionReporter', () => {
  it('logs each listing/host pair once with listingId and host', () => {
    const log: jest.MockedFunction<TourRejectionLogger> = jest.fn();
    const report = createTourRejectionReporter(log);
    const rejection = {
      listingId: 'l-1',
      host: 'evil.example',
      reason: 'HOST_NOT_ALLOWED' as const,
    };

    report([rejection, rejection]);
    report([rejection]);
    report([
      { ...rejection, listingId: 'l-2' },
      { ...rejection, host: 'other.example' },
    ]);

    expect(log.mock.calls).toEqual([
      ['tour not embedded', { listingId: 'l-1', host: 'evil.example', reason: 'HOST_NOT_ALLOWED' }],
      ['tour not embedded', { listingId: 'l-2', host: 'evil.example', reason: 'HOST_NOT_ALLOWED' }],
      [
        'tour not embedded',
        { listingId: 'l-1', host: 'other.example', reason: 'HOST_NOT_ALLOWED' },
      ],
    ]);
  });
});
