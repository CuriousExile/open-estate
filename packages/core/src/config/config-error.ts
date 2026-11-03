/**
 * Internal start-up errors of the ConfigProvider (Req 9.4, 11.2). They abort the
 * Lambda init and are deliberately not part of the API error catalog in `shared`.
 */
export type ConfigErrorCode = 'CONFIG_MISSING' | 'CONFIG_INVALID';

export interface ConfigIssue {
  /** Dot-separated path inside the config file; empty for the document itself. */
  path: string;
  message: string;
}

/** Machine-readable form, e.g. for the init log line. */
export interface ConfigErrorJson {
  code: ConfigErrorCode;
  names: string[];
  issues?: ConfigIssue[];
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  /**
   * @param names every affected config value or file key. `Error.name` is taken,
   *   so the design's `name` field is exposed as `names` (all of them, Property 23).
   */
  constructor(
    readonly code: ConfigErrorCode,
    readonly names: readonly string[],
    readonly issues?: readonly ConfigIssue[],
  ) {
    super(`${code}: ${names.join(', ')}`);
  }

  toJSON(): ConfigErrorJson {
    return {
      code: this.code,
      names: [...this.names],
      ...(this.issues ? { issues: [...this.issues] } : {}),
    };
  }
}
