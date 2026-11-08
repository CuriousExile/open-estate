import {
  DEFAULT_DUPLICATE_CONFIG,
  DUPLICATE_CONFIG_FILE,
  DuplicateConfig,
} from '@open-estate/shared';
import { loadOptionalConfigFile, type ConfigSources } from '../config/config-provider';

/**
 * Duplikat_Konfiguration from the config bucket (duplicate-detection Req 3.8, 3.9). The file is
 * optional: without it the documented defaults apply. An invalid file throws a `ConfigError`
 * naming every invalid field, so the Lambda does not start with guessed values. Read once per
 * cold start; `open-estate-admin reload` picks up a changed file.
 */
export function loadDuplicateConfig(sources: ConfigSources = {}): Promise<DuplicateConfig> {
  return loadOptionalConfigFile(
    DUPLICATE_CONFIG_FILE,
    DuplicateConfig,
    DEFAULT_DUPLICATE_CONFIG,
    sources,
  );
}
