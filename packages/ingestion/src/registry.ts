import { err, ok, type ImportMode, type Result } from '@open-estate/shared';
import type { ZodType } from 'zod';
import type { Connector, ConnectorType } from './connector';
import type { ConnectorConfig } from './connector-config';

/**
 * A connector implementation as it is made known to the framework.
 * Each module brings its own schema for `settings` (checked before `initialize`).
 */
export interface ConnectorModule<TSettings = unknown> {
  /** Value referenced by `connectors.json` → `module`. */
  readonly name: string;
  readonly type: ConnectorType;
  readonly settingsSchema: ZodType<TSettings>;
  /** Used when the config sets no `importMode`; absent → `MERGE` (Req 12.16, 12.17). */
  readonly defaultImportMode?: ImportMode;
  /** Fresh instance per run; connectors keep per-run state (status counters). */
  create(): Connector<TSettings>;
}

export type RegistryErrorCode = 'UNKNOWN_MODULE' | 'TYPE_MISMATCH';

export interface RegistryError {
  readonly code: RegistryErrorCode;
  readonly connectorId: string;
  readonly module: string;
  /** Value-free, human-readable reason for the run log. */
  readonly reason: string;
}

/**
 * Resolves `connectors.json` entries to connector modules.
 *
 * Deliberately a closed map of module name → module instead of `import(config.module)`:
 * the config file lives in a bucket and must never be able to load arbitrary code.
 * Adding a connector means shipping a module and listing it where the registry is
 * built; the framework core stays untouched (Req 5.1).
 */
export class ConnectorRegistry {
  private readonly modules = new Map<string, ConnectorModule>();

  constructor(modules: readonly ConnectorModule[] = []) {
    for (const module of modules) this.register(module);
  }

  /** Throws on duplicate names: that is a programming error, not a config error. */
  register(module: ConnectorModule): this {
    if (this.modules.has(module.name)) {
      throw new Error(`connector module already registered: ${module.name}`);
    }
    this.modules.set(module.name, module);
    return this;
  }

  /** Registered module names, sorted. */
  names(): string[] {
    return [...this.modules.keys()].sort();
  }

  resolve(
    config: Pick<ConnectorConfig, 'id' | 'type' | 'module'>,
  ): Result<ConnectorModule, RegistryError> {
    const module = this.modules.get(config.module);
    const base = { connectorId: config.id, module: config.module };
    if (!module) {
      return err({
        ...base,
        code: 'UNKNOWN_MODULE',
        reason: `unknown connector module "${config.module}"`,
      });
    }
    if (module.type !== config.type) {
      return err({
        ...base,
        code: 'TYPE_MISMATCH',
        reason: `module "${module.name}" has type "${module.type}", configured type is "${config.type}"`,
      });
    }
    return ok(module);
  }
}
