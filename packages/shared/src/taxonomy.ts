import * as z from 'zod';
import defaultTaxonomyJson from './config/taxonomy.json';

// Property taxonomy (Req 15.1, 15.2, 15.4). The Zod schemas below only check the structure of
// `taxonomy.json`; code rules (length, global uniqueness, group assignment) are checked by
// `validateTaxonomy` so that all violations are collected and reported per code.

export const TAXONOMY_CODE_MIN_LENGTH = 1;
export const TAXONOMY_CODE_MAX_LENGTH = 64;

/** Nested format: the group assignment follows from nesting. */
export const NestedTaxonomyConfig = z.strictObject({
  groups: z.array(z.strictObject({ code: z.string(), types: z.array(z.string()) })),
});
export type NestedTaxonomyConfig = z.infer<typeof NestedTaxonomyConfig>;

/** Flat format: each type references its group by code; references are checked (Req 15.4). */
export const FlatTaxonomyConfig = z.strictObject({
  groups: z.array(z.strictObject({ code: z.string() })),
  types: z.array(z.strictObject({ code: z.string(), group: z.string() })),
});
export type FlatTaxonomyConfig = z.infer<typeof FlatTaxonomyConfig>;

/** Structure of `taxonomy.json` (either format). */
export const TaxonomyConfig = z.union([NestedTaxonomyConfig, FlatTaxonomyConfig]);
export type TaxonomyConfig = z.infer<typeof TaxonomyConfig>;

/** Validated, normalized taxonomy (nested; every type belongs to exactly one group). */
export interface Taxonomy {
  readonly groups: readonly { readonly code: string; readonly types: readonly string[] }[];
}

export const TAXONOMY_VIOLATIONS = [
  'DUPLICATE_CODE',
  'INVALID_CODE_LENGTH',
  'UNKNOWN_GROUP',
] as const;
export type TaxonomyViolationKind = (typeof TAXONOMY_VIOLATIONS)[number];

export interface TaxonomyViolation {
  violation: TaxonomyViolationKind;
  /** Affected group or type code. */
  code: string;
  message: string;
}

export type TaxonomyValidationResult =
  { success: true; taxonomy: Taxonomy } | { success: false; violations: TaxonomyViolation[] };

function isFlat(config: TaxonomyConfig): config is FlatTaxonomyConfig {
  return 'types' in config;
}

/**
 * Checks all code rules and collects every violation (one entry per affected code and kind):
 * length 1–64, uniqueness across groups and types, and (flat format) types referencing a defined group.
 */
export function validateTaxonomy(config: TaxonomyConfig): TaxonomyValidationResult {
  const groups = config.groups.map((g) => g.code);
  const types: { code: string; group: string }[] = isFlat(config)
    ? config.types
    : config.groups.flatMap((g) => g.types.map((code) => ({ code, group: g.code })));

  const violations = new Map<string, TaxonomyViolation>();
  const report = (violation: TaxonomyViolationKind, code: string, message: string): void => {
    violations.set(`${violation}\u0000${code}`, { violation, code, message });
  };

  const seen = new Set<string>();
  for (const code of [...groups, ...types.map((t) => t.code)]) {
    if (code.length < TAXONOMY_CODE_MIN_LENGTH || code.length > TAXONOMY_CODE_MAX_LENGTH) {
      report(
        'INVALID_CODE_LENGTH',
        code,
        `Code "${code}" must be ${TAXONOMY_CODE_MIN_LENGTH}-${TAXONOMY_CODE_MAX_LENGTH} characters long`,
      );
    }
    if (seen.has(code)) {
      report('DUPLICATE_CODE', code, `Code "${code}" is not unique across groups and types`);
    }
    seen.add(code);
  }

  const definedGroups = new Set(groups);
  for (const type of types) {
    if (!definedGroups.has(type.group)) {
      report(
        'UNKNOWN_GROUP',
        type.code,
        `Type "${type.code}" references undefined group "${type.group}"`,
      );
    }
  }

  if (violations.size > 0) {
    return { success: false, violations: [...violations.values()] };
  }
  return {
    success: true,
    taxonomy: {
      groups: groups.map((code) => ({
        code,
        types: types.filter((t) => t.group === code).map((t) => t.code),
      })),
    },
  };
}

/** Thrown at startup when the taxonomy is invalid; the start must be aborted (Req 15.4). */
export class TaxonomyValidationError extends Error {
  constructor(readonly violations: readonly TaxonomyViolation[]) {
    super(`Invalid taxonomy: ${violations.map((v) => `${v.violation} ${v.code}`).join('; ')}`);
    this.name = 'TaxonomyValidationError';
  }
}

/** Validates and returns the normalized taxonomy or throws `TaxonomyValidationError`. */
export function assertValidTaxonomy(config: TaxonomyConfig): Taxonomy {
  const result = validateTaxonomy(config);
  if (!result.success) {
    throw new TaxonomyValidationError(result.violations);
  }
  return result.taxonomy;
}

/** Default taxonomy shipped with the repository (Req 15.2); source file: `config/taxonomy.json`. */
export const DEFAULT_TAXONOMY_CONFIG: NestedTaxonomyConfig = defaultTaxonomyJson;

export function groupCodes(taxonomy: Taxonomy): string[] {
  return taxonomy.groups.map((g) => g.code);
}

export function typeCodes(taxonomy: Taxonomy): string[] {
  return taxonomy.groups.flatMap((g) => g.types);
}

/** Type codes of a group (exact, case-sensitive match); `undefined` for an unknown group. */
export function typesOfGroup(taxonomy: Taxonomy, groupCode: string): readonly string[] | undefined {
  return taxonomy.groups.find((g) => g.code === groupCode)?.types;
}

/** Group code of a type (exact, case-sensitive match); `undefined` for an unknown type. */
export function groupOfType(taxonomy: Taxonomy, typeCode: string): string | undefined {
  return taxonomy.groups.find((g) => g.types.includes(typeCode))?.code;
}
