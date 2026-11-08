import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigError, loadDuplicateConfig, loadOptionalConfigFile } from '@open-estate/core';
import { DEFAULT_DUPLICATE_CONFIG, DUPLICATE_CONFIG_FILE } from '@open-estate/shared';
import { z } from 'zod';

// Loading of the Duplikat_Konfiguration (duplicate-detection Req 3.8, 3.9).

const BUCKET_ENV = { CONFIG_BUCKET: 'config-bucket' };

/** S3 client serving `files` from the config bucket; a missing key answers `NoSuchKey`. */
function s3With(files: Record<string, string>): S3Client {
  const s3 = new S3Client({ region: 'eu-central-1' });
  jest.spyOn(s3, 'send').mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('unexpected command');
    const body = files[command.input.Key ?? ''];
    if (body === undefined) {
      throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    }
    return { Body: { transformToString: async () => body } };
  });
  return s3;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('loadDuplicateConfig', () => {
  it('uses the documented defaults without a file (Req 3.8)', async () => {
    const config = await loadDuplicateConfig({ env: BUCKET_ENV, s3: s3With({}) });
    expect(config).toEqual(DEFAULT_DUPLICATE_CONFIG);
  });

  it('merges a partial file with the defaults', async () => {
    const s3 = s3With({
      [DUPLICATE_CONFIG_FILE]: JSON.stringify({ threshold: 0.8, weights: { SAME_ADDRESS: 0.4 } }),
    });
    const config = await loadDuplicateConfig({ env: BUCKET_ENV, s3 });
    expect(config.threshold).toBe(0.8);
    expect(config.weights.SAME_ADDRESS).toBe(0.4);
    expect(config.weights.GEO_NEAR).toBe(DEFAULT_DUPLICATE_CONFIG.weights.GEO_NEAR);
  });

  it('refuses an invalid file and names every invalid field (Req 3.9)', async () => {
    const s3 = s3With({
      [DUPLICATE_CONFIG_FILE]: JSON.stringify({ threshold: 3, sweep: { timeUtc: '25:00' } }),
    });
    const error = await rejection(loadDuplicateConfig({ env: BUCKET_ENV, s3 }));
    expect(error).toBeInstanceOf(ConfigError);
    const fields = ((error as ConfigError).issues ?? []).map((issue) => issue.path);
    expect(fields).toEqual(expect.arrayContaining(['threshold', 'sweep.timeUtc']));
  });
});

describe('loadOptionalConfigFile', () => {
  it('does not mistake a missing config bucket for a missing file', async () => {
    const error = await rejection(
      loadOptionalConfigFile('x.json', z.unknown(), 'fallback', { env: {}, s3: s3With({}) }),
    );
    expect(error).toBeInstanceOf(ConfigError);
  });
});
