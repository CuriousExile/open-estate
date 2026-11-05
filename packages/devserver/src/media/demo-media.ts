import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseIllustration, renderIllustration } from './illustrations';

// DEV ONLY: images of the demo listings. Listing media must be https URLs (schema, Req 16.1), but
// the local demo runs on plain http. So the seed stores them under the reserved host below, and
// the dev server rewrites that origin in Search_API and MCP responses to `<frontend>/demo-media/`
// (proxied by `ng serve` like `/api`, so the SPA loads them same-origin). Management_API
// responses keep the stored https URLs: the portal validates them with the listing schema.
//
//   /demo-media/art/<scene>-<time>-<palette>.svg   generated illustration (./illustrations)
//   /demo-media/photos/<name>.webp                 crop of the project's own hero image

/** Origin of demo media URLs as stored; `.localhost` is reserved (RFC 6761) and never resolves. */
export const DEMO_MEDIA_ORIGIN = 'https://demo-media.localhost';
/** Path prefix under which this server (and the `ng serve` proxy) serves the demo media. */
export const DEMO_MEDIA_PREFIX = '/demo-media';

/** Directory of the photo crops: `packages/devserver/media/photos` (next to `src`/`dist`). */
export const PHOTO_DIR = path.resolve(__dirname, '..', '..', 'media', 'photos');

export const demoArt = (name: string): { url: string } => ({
  url: `${DEMO_MEDIA_ORIGIN}/art/${name}.svg`,
});
export const demoPhoto = (name: string): { url: string } => ({
  url: `${DEMO_MEDIA_ORIGIN}/photos/${name}.webp`,
});

export interface MediaResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

const PHOTO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMON_HEADERS = {
  'Cache-Control': 'public, max-age=3600',
  'X-Content-Type-Options': 'nosniff',
  // SVGs opened directly must not run anything (they never contain scripts anyway).
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const notFound = (): MediaResponse => ({
  status: 404,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  body: 'Demo image not found\n',
});

/**
 * Serves `GET /demo-media/...`; `relative` is the path after the prefix. Only the two fixed
 * layouts are accepted; names are matched by pattern, so no path traversal is possible.
 */
export function serveDemoMedia(relative: string, photoDir: string = PHOTO_DIR): MediaResponse {
  const art = /^\/art\/([a-z-]+)\.svg$/.exec(relative);
  if (art) {
    const illustration = parseIllustration(art[1] ?? '');
    if (illustration === undefined) return notFound();
    return {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', ...COMMON_HEADERS },
      body: renderIllustration(illustration),
    };
  }
  const photo = /^\/photos\/([^/]+)\.webp$/.exec(relative);
  if (photo && PHOTO_NAME.test(photo[1] ?? '')) {
    try {
      return {
        status: 200,
        headers: { 'Content-Type': 'image/webp', ...COMMON_HEADERS },
        body: readFileSync(path.join(photoDir, `${photo[1] ?? ''}.webp`)),
      };
    } catch {
      return notFound();
    }
  }
  return notFound();
}

/**
 * Rewrites stored demo media URLs in a JSON response body to where the browser can load them
 * (`publicBase` = `<frontend origin>/demo-media`). Other URLs are untouched.
 */
export function publishDemoMediaUrls(body: string, publicBase: string): string {
  return body.split(`${DEMO_MEDIA_ORIGIN}/`).join(`${publicBase.replace(/\/+$/, '')}/`);
}
