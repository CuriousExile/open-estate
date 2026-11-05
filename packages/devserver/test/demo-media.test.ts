import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpsUrl } from '@open-estate/shared';
import { DemoClock, loadContentConfig } from '../src/config';
import {
  DEMO_MEDIA_ORIGIN,
  PHOTO_DIR,
  publishDemoMediaUrls,
  serveDemoMedia,
} from '../src/media/demo-media';
import {
  illustrationName,
  PALETTES,
  parseIllustration,
  renderIllustration,
  SCENES,
  TIMES,
} from '../src/media/illustrations';
import { createDevPlatform, type DevPlatform } from '../src/platform';
import { demoFeedModule } from '../src/seed/demo-connector';
import { CRM_RECORDS, MANUAL_LISTINGS, SEED_USERS } from '../src/seed/demo-data';
import { CRM_BATCHES, seedDemo } from '../src/seed/seed';
import { createRequestListener } from '../src/server';

const FRONTEND = 'http://127.0.0.1:4200';
const PUBLIC_BASE = `${FRONTEND}/demo-media`;

describe('demo illustrations', () => {
  it('renders every scene, time and palette as a standalone SVG without scripts', () => {
    for (const scene of SCENES) {
      for (const time of TIMES) {
        for (const palette of Object.keys(PALETTES) as (keyof typeof PALETTES)[]) {
          const svg = renderIllustration({ scene, time, palette });
          expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
          expect(svg).not.toMatch(/<script|on[a-z]+=|href=/i);
          expect(svg).not.toContain('NaN');
        }
      }
    }
  });

  it('is deterministic and round-trips its name', () => {
    const art = { scene: 'villa', time: 'night', palette: 'white' } as const;
    expect(renderIllustration(art)).toBe(renderIllustration(art));
    expect(parseIllustration(illustrationName(art))).toEqual(art);
  });

  it('rejects unknown names', () => {
    for (const name of [
      '',
      'castle-day-sand',
      'house-noon-sand',
      'house-day-pink',
      'house-day-sand-x',
    ]) {
      expect(parseIllustration(name)).toBeUndefined();
    }
    expect(parseIllustration('house-day-toString')).toBeUndefined();
  });
});

describe('serveDemoMedia', () => {
  it('serves illustrations as SVG and photos as WebP', () => {
    const art = serveDemoMedia('/art/house-day-sand.svg');
    expect(art.status).toBe(200);
    expect(art.headers['Content-Type']).toBe('image/svg+xml; charset=utf-8');
    expect(art.headers['X-Content-Type-Options']).toBe('nosniff');

    const photo = serveDemoMedia('/photos/villa-pool.webp');
    expect(photo.status).toBe(200);
    expect(photo.headers['Content-Type']).toBe('image/webp');
    expect((photo.body as Buffer).subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('answers 404 for unknown files, other layouts and traversal attempts', () => {
    for (const path of [
      '/art/castle-day-sand.svg',
      '/photos/lost-in-the-move.webp',
      '/photos/../../package.json',
      '/photos/..%2F..%2Fpackage.json.webp',
      '/photos/Villa.webp',
      '/other/a.svg',
      '/',
    ]) {
      expect(serveDemoMedia(path, PHOTO_DIR).status).toBe(404);
    }
  });
});

describe('publishDemoMediaUrls', () => {
  it('rewrites only the stored demo media origin', () => {
    const body = JSON.stringify({
      media: [
        { url: `${DEMO_MEDIA_ORIGIN}/art/house-day-sand.svg` },
        { url: 'https://cdn.example.org/a.jpg' },
      ],
    });
    expect(JSON.parse(publishDemoMediaUrls(body, `${PUBLIC_BASE}/`))).toEqual({
      media: [
        { url: `${PUBLIC_BASE}/art/house-day-sand.svg` },
        { url: 'https://cdn.example.org/a.jpg' },
      ],
    });
  });
});

describe('seed media', () => {
  const urls = [
    ...MANUAL_LISTINGS.flatMap((seed) => seed.content['media'] as { url: string }[]),
    ...Object.values(CRM_RECORDS).flatMap((record) => record.media as readonly { url: string }[]),
  ].map((medium) => medium.url);

  it('stores valid https URLs of the demo media origin, all but one resolvable', () => {
    expect(urls.length).toBeGreaterThan(20);
    for (const url of urls) {
      expect(HttpsUrl.safeParse(url).success).toBe(true);
      expect(url.startsWith(`${DEMO_MEDIA_ORIGIN}/`)).toBe(true);
    }
    const missing = urls.filter(
      (url) => serveDemoMedia(url.slice(DEMO_MEDIA_ORIGIN.length)).status !== 200,
    );
    expect(missing).toEqual([`${DEMO_MEDIA_ORIGIN}/photos/lost-in-the-move.webp`]);
  });

  it('has public listings without images and with one to five images', () => {
    const active = [
      ...MANUAL_LISTINGS.filter((seed) => seed.status === 'ACTIVE').map((seed) => seed.content),
      ...Object.values(CRM_RECORDS).filter((record) => record.status === 'ACTIVE'),
    ];
    const counts = active.map((content) => (content['media'] as readonly unknown[]).length);
    expect(counts).toContain(0);
    expect(Math.max(...counts)).toBe(5);
    expect(Math.min(...counts.filter((n) => n > 0))).toBe(1);
  });
});

describe('demo media over HTTP', () => {
  let platform: DevPlatform;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    platform = createDevPlatform({
      config: loadContentConfig(),
      clock: new DemoClock(),
      frontendOrigin: FRONTEND,
      issuer: 'http://127.0.0.1:4310/oidc',
      clientId: 'local-portal-client',
      directoryUsers: SEED_USERS,
      connectorModules: [demoFeedModule(CRM_BATCHES)],
      logger: { error: () => undefined },
    });
    await seedDemo(platform);
    server = createServer(
      createRequestListener({ platform, info: () => ({}), mediaPublicBase: PUBLIC_BASE }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves GET and HEAD, refuses other methods', async () => {
    const get = await fetch(`${base}/demo-media/art/chalet-night-timber.svg`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(await get.text()).toContain('<svg');
    const head = await fetch(`${base}/demo-media/photos/villa-pool.webp`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await fetch(`${base}/demo-media/art/x.svg`)).status).toBe(404);
    expect(
      (await fetch(`${base}/demo-media/art/house-day-sand.svg`, { method: 'POST' })).status,
    ).toBe(405);
  });

  it('publishes demo media URLs in Search_API responses', async () => {
    const search = (await (await fetch(`${base}/api/listings?pageSize=50`)).json()) as {
      items: { media: { url: string }[] }[];
    };
    const urls = search.items.flatMap((item) => item.media.map((medium) => medium.url));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith(`${PUBLIC_BASE}/`))).toBe(true);
  });
});
