import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { I18nConfig } from '@open-estate/core';
import { FRONTEND_RUNTIME_FILES, NO_CACHE_CONTROL } from '../../src/frontend-stack';
import {
  describeE2e,
  pollUntil,
  runMarker,
  stackOutput,
  stackResource,
  timedFetch,
} from './deployed-env';

/**
 * Runtime files of the deployed frontend (task 19.5). The suite edits them in the frontend bucket
 * as an administrator would (docs/configuration.md) and checks what the SPA receives through
 * CloudFront on its next load: a changed theme within 5 s (Req 8.2) and a new locale without
 * rebuild — `index.html`, which references the hashed bundles, stays unchanged (Req 13.3). How the
 * SPA applies the files is covered by the frontend unit tests; no browser runs here.
 * Every touched object is restored (or deleted, if it did not exist) after each test.
 *
 * **Validates: Requirements 8.2, 13.3**
 */

/** Req 8.2: changed branding is applied within 5 s after a reload. */
const THEME_RELOAD_BUDGET_MS = 5_000;
/** Locales for the test, the first one neither enabled nor present in the bucket is used. */
const CANDIDATE_LOCALES = ['eo', 'ia', 'la', 'vo'];

interface StoredObject {
  body: string;
  contentType: string | undefined;
  cacheControl: string | undefined;
}

interface Theme {
  texts?: { appTitle?: Record<string, string> } & Record<string, unknown>;
  [key: string]: unknown;
}

describeE2e('Frontend runtime files (deployed)', () => {
  const s3 = new S3Client({});
  const marker = runMarker();
  let frontendUrl: string;
  let bucket: string;
  let restores: (() => Promise<unknown>)[] = [];

  const fileUrl = (key: string) => new URL(key, `${frontendUrl}/`);
  const translationKey = (locale: string) =>
    `${FRONTEND_RUNTIME_FILES.translationsDir}/${locale}.json`;

  async function getStored(key: string): Promise<StoredObject | undefined> {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return {
        body: (await object.Body?.transformToString()) ?? '',
        contentType: object.ContentType,
        cacheControl: object.CacheControl,
      };
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  /** Uploads like an administrator (`no-cache`) and registers the restore of the prior state. */
  async function upload(key: string, content: unknown, previous: StoredObject | undefined) {
    restores.push(() =>
      previous === undefined
        ? s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
        : s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: previous.body,
              ContentType: previous.contentType,
              CacheControl: previous.cacheControl,
            }),
          ),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(content),
        ContentType: 'application/json',
        CacheControl: NO_CACHE_CONTROL,
      }),
    );
  }

  /** JSON of `key` as served by CloudFront. */
  async function served<T>(key: string): Promise<T> {
    const response = await timedFetch(fileUrl(key));
    if (response.status !== 200) throw new Error(`GET ${key}: ${response.status}`);
    return JSON.parse(response.body) as T;
  }

  beforeAll(async () => {
    frontendUrl = await stackOutput('Frontend', 'FrontendUrl');
    bucket = await stackResource('Frontend', 'SiteBucket', 'AWS::S3::Bucket');
  }, 60_000);

  afterEach(async () => {
    const pending = restores.reverse();
    restores = [];
    for (const restore of pending) await restore();
  });

  test('a changed theme is served within 5 s after upload (Req 8.2)', async () => {
    const { defaultLocale } = I18nConfig.parse(await served(FRONTEND_RUNTIME_FILES.i18nConfig));
    const key = FRONTEND_RUNTIME_FILES.themeConfig;
    const previous = await getStored(key);
    const theme = previous === undefined ? {} : (JSON.parse(previous.body) as Theme);
    const title = `Open Estate ${marker}`;
    await upload(
      key,
      {
        ...theme,
        texts: { ...theme.texts, appTitle: { ...theme.texts?.appTitle, [defaultLocale]: title } },
      },
      previous,
    );

    const start = performance.now();
    const response = await pollUntil(
      'the changed theme',
      async () => {
        const r = await timedFetch(fileUrl(key));
        return r.status === 200 && r.body.includes(marker) ? r : undefined;
      },
      { timeoutMs: 30_000, intervalMs: 250 },
    );
    expect(performance.now() - start).toBeLessThanOrEqual(THEME_RELOAD_BUDGET_MS);
    // Browsers revalidate on every reload instead of using a cached copy.
    expect(response.headers.get('cache-control')).toContain(NO_CACHE_CONTROL);
  }, 60_000);

  test('a new locale is offered on the next load without rebuild (Req 13.3)', async () => {
    const indexBefore = await timedFetch(fileUrl(FRONTEND_RUNTIME_FILES.index));
    const configKey = FRONTEND_RUNTIME_FILES.i18nConfig;
    const previousConfig = await getStored(configKey);
    if (previousConfig === undefined) throw new Error(`${configKey} missing in ${bucket}`);
    const config = I18nConfig.parse(JSON.parse(previousConfig.body));

    let locale: string | undefined;
    for (const candidate of CANDIDATE_LOCALES) {
      const enabled = config.enabled.some((e) => e.locale.toLowerCase() === candidate);
      if (!enabled && (await getStored(translationKey(candidate))) === undefined) {
        locale = candidate;
        break;
      }
    }
    if (locale === undefined) throw new Error(`All of ${CANDIDATE_LOCALES.join(', ')} are in use`);

    // Copy of the default-locale file, every text marked, as docs/configuration.md describes.
    const defaults = await served<Record<string, string>>(translationKey(config.defaultLocale));
    const translations = Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [k, `[${marker}] ${v}`]),
    );
    await upload(translationKey(locale), translations, undefined);
    const updated = I18nConfig.parse({
      ...config,
      enabled: [...config.enabled, { locale, label: `E2E ${marker}` }],
    });
    await upload(configKey, updated, previousConfig);

    const offered = await pollUntil(
      'the new locale in i18n-config.json',
      async () => {
        const current = I18nConfig.parse(await served(configKey));
        return current.enabled.some((e) => e.locale === locale) ? current : undefined;
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    expect(offered.enabled).toContainEqual({ locale, label: `E2E ${marker}` });
    expect(await served(translationKey(locale))).toEqual(translations);

    const indexAfter = await timedFetch(fileUrl(FRONTEND_RUNTIME_FILES.index));
    expect(indexAfter.status).toBe(200);
    expect(indexAfter.body).toBe(indexBefore.body);
  }, 90_000);
});
