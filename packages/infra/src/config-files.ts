import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { I18nConfig, READ_MODEL_CONFIG_FILES } from '@open-estate/core';
import {
  CONNECTOR_CONFIG_FILES,
  connectorsFileSchema,
  crawlerAllowlistSchema,
} from '@open-estate/ingestion';
import {
  FlatTaxonomyConfig,
  NestedTaxonomyConfig,
  PiiAllowlistConfig,
  TourProvidersConfig,
  validateTaxonomy,
} from '@open-estate/shared';

/** A config file that passed validation; uploaded unchanged to the config bucket. */
export interface ConfigFile {
  /** Object key in the config bucket (= file name). */
  readonly key: string;
  readonly content: string;
}

/** Returns human-readable problems of a parsed file; empty means valid. */
type ConfigFileValidator = (json: unknown) => string[];

const validateTaxonomyFile: ConfigFileValidator = (json) => {
  // Check against the format the file uses (top-level `types` = flat): the union schema would only
  // report "Invalid input" at the root.
  const isFlat = typeof json === 'object' && json !== null && 'types' in json;
  const parsed = (isFlat ? FlatTaxonomyConfig : NestedTaxonomyConfig).safeParse(json);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
  }
  const result = validateTaxonomy(parsed.data);
  return result.success
    ? []
    : result.violations.map((v) => `${v.violation} ${JSON.stringify(v.code)}: ${v.message}`);
};

/** Validator from the same Zod schema the runtime parses the file with. */
interface ConfigSchema {
  safeParse(
    json: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

const schemaValidator =
  (schema: ConfigSchema): ConfigFileValidator =>
  (json) => {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? []
      : parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
        );
  };

/**
 * Files with a schema in `@open-estate/shared`/`core`/`ingestion`, each validated with the schema
 * its runtime parses it with. New config files are registered here together with their schema;
 * unknown files are rejected instead of being uploaded unvalidated.
 */
export const CONFIG_FILE_VALIDATORS: Readonly<Record<string, ConfigFileValidator>> = {
  [READ_MODEL_CONFIG_FILES.taxonomy]: validateTaxonomyFile,
  [READ_MODEL_CONFIG_FILES.i18n]: schemaValidator(I18nConfig),
  [READ_MODEL_CONFIG_FILES.tourProviders]: schemaValidator(TourProvidersConfig),
  [CONNECTOR_CONFIG_FILES.piiAllowlist]: schemaValidator(PiiAllowlistConfig),
  [CONNECTOR_CONFIG_FILES.crawlerAllowlist]: schemaValidator(crawlerAllowlistSchema),
  // Also drives the IngestionStack (schedules, timeouts, secrets), see `connectorsFromConfigFiles`.
  [CONNECTOR_CONFIG_FILES.connectors]: schemaValidator(connectorsFileSchema),
};

/** Files the config bucket must receive (from the directory or mirrored). */
export const REQUIRED_CONFIG_FILES: readonly string[] = [
  READ_MODEL_CONFIG_FILES.taxonomy,
  READ_MODEL_CONFIG_FILES.i18n,
];

/** Synth-time failure listing every problem of every file. */
export class ConfigDirectoryError extends Error {
  constructor(
    readonly configDir: string,
    readonly problems: readonly string[],
  ) {
    super(`Invalid configuration in ${configDir}:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigDirectoryError';
  }
}

function readEntries(configDir: string): string[] {
  try {
    if (!statSync(configDir).isDirectory()) throw new Error('not a directory');
    return readdirSync(configDir).sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigDirectoryError(configDir, [`cannot read directory: ${message}`]);
  }
}

function readFile(filePath: string): { content: string } | { problem: string } {
  try {
    return { content: readFileSync(filePath, 'utf8') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { problem: `cannot read ${filePath}: ${message}` };
  }
}

/**
 * Loads and validates all files of `configDir` plus the `mirrored` files (key → path of a file
 * owned by another package, e.g. the frontend's `i18n-config.json`), Req 15.4 at `cdk synth`.
 * Collects every problem (missing required file, unknown file, a mirrored key also present in the
 * directory, invalid JSON, schema or taxonomy violations with codes) and throws one
 * {@link ConfigDirectoryError}; otherwise returns the files to upload.
 */
export function loadConfigDirectory(
  configDir: string,
  mirrored: Readonly<Record<string, string>> = {},
): ConfigFile[] {
  const entries = readEntries(configDir);
  const problems: string[] = [];
  const files: ConfigFile[] = [];
  const sources = new Map(entries.map((key) => [key, path.join(configDir, key)]));
  for (const [key, filePath] of Object.entries(mirrored)) {
    if (sources.has(key)) {
      problems.push(`${key}: mirrored from ${filePath}; remove it from the config directory`);
    }
    sources.set(key, filePath);
  }

  for (const required of REQUIRED_CONFIG_FILES) {
    if (!sources.has(required)) problems.push(`${required}: missing`);
  }
  for (const [key, filePath] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
    const validate = CONFIG_FILE_VALIDATORS[key];
    if (validate === undefined) {
      problems.push(
        `${key}: unknown config file (known: ${Object.keys(CONFIG_FILE_VALIDATORS).join(', ')})`,
      );
      continue;
    }
    const read = readFile(filePath);
    if ('problem' in read) {
      problems.push(`${key}: ${read.problem}`);
      continue;
    }
    const { content } = read;
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${key}: invalid JSON (${message})`);
      continue;
    }
    const fileProblems = validate(json);
    problems.push(...fileProblems.map((p) => `${key}: ${p}`));
    if (fileProblems.length === 0) files.push({ key, content });
  }

  if (problems.length > 0) throw new ConfigDirectoryError(configDir, problems);
  return files;
}
