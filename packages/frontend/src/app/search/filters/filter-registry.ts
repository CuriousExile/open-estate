// Framework-free registry model of the "More filters" view. A filter is a declarative definition
// bound to fields of the search form; rendering, the active-filter badge, reset, URL mapping and
// validation all derive from the definitions, so a new filter needs only a new entry in
// `extra-filters.ts` (plus its translation keys). Kept free of Angular for plain Jest tests.
import type { SearchMeta } from '../search-meta';
import {
  SEARCH_FORM_FIELDS,
  validateSearchForm,
  type SearchFormError,
  type SearchFormField,
  type SearchFormValues,
} from '../validate-search-form';

/** Form fields holding text (decimal inputs included). */
export type TextFormField = {
  [K in SearchFormField]-?: NonNullable<SearchFormValues[K]> extends string ? K : never;
}[SearchFormField];
/** Form fields holding a boolean. */
export type BooleanFormField = {
  [K in SearchFormField]-?: NonNullable<SearchFormValues[K]> extends boolean ? K : never;
}[SearchFormField];

interface FilterBase {
  /** Stable id (DOM ids, tests). */
  id: string;
  /** Transloco key of the visible label. */
  labelKey: string;
  /** Optional Transloco key of a hint below the control. */
  hintKey?: string;
  /**
   * Extra frontend-only rule on top of the shared search schema (which always applies): returns
   * an error for one of the filter's fields, or `undefined`.
   */
  validate?: (values: SearchFormValues) => SearchFormError | undefined;
}

/** On/off switch, e.g. "with 3D tour" (`hasTour=true`; off = no filter). */
export interface ToggleFilter extends FilterBase {
  kind: 'toggle';
  field: BooleanFormField;
}

/** Free text, e.g. a postal code. */
export interface TextFilter extends FilterBase {
  kind: 'text';
  field: TextFormField;
  maxLength: number;
  inputMode?: 'text' | 'numeric' | 'decimal';
  autocomplete?: string;
  /** Transloco key of the placeholder. */
  placeholderKey?: string;
}

/** Single decimal value, e.g. "max. rooms". */
export interface NumberFilter extends FilterBase {
  kind: 'number';
  field: TextFormField;
  /** Transloco key of the unit chip, e.g. "m²". */
  unitKey?: string;
  placeholderKey?: string;
}

/** Min/max pair, e.g. living area. */
export interface NumberRangeFilter extends FilterBase {
  kind: 'number-range';
  min: TextFormField;
  max: TextFormField;
  unitKey?: string;
}

export interface FilterChoice {
  value: string;
  /** Transloco key of the label. */
  labelKey: string;
}

/** One value out of a list (shared `oe-select`); `''` = no filter. */
export interface SelectFilter extends FilterBase {
  kind: 'select';
  field: TextFormField;
  /** Transloco key of the "any" entry. */
  anyLabelKey: string;
  /** Choices, possibly from `/meta` (e.g. the taxonomy). No choices → the filter is hidden. */
  choices: (meta: SearchMeta) => readonly FilterChoice[];
}

export type FilterDefinition =
  ToggleFilter | TextFilter | NumberFilter | NumberRangeFilter | SelectFilter;

export type FilterKind = FilterDefinition['kind'];

/** Values of the filters' fields only (the draft of the "More filters" view). */
export type FilterValues = Partial<Pick<SearchFormValues, SearchFormField>>;

/** Form fields a definition owns; they are also its URL query parameters. */
export function filterFields(definition: FilterDefinition): SearchFormField[] {
  return definition.kind === 'number-range' ? [definition.min, definition.max] : [definition.field];
}

/** All fields owned by `definitions`, in definition order. */
export function registryFields(definitions: readonly FilterDefinition[]): SearchFormField[] {
  return definitions.flatMap(filterFields);
}

/**
 * Checks a registry: unique ids, every field owned by exactly one definition and none of the
 * `reserved` fields (those of the main bar). Returns the problems (empty = valid).
 */
export function registryProblems(
  definitions: readonly FilterDefinition[],
  reserved: readonly SearchFormField[] = [],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const owners = new Map<SearchFormField, string>();
  for (const field of reserved) owners.set(field, 'main bar');
  for (const definition of definitions) {
    if (ids.has(definition.id)) problems.push(`duplicate filter id "${definition.id}"`);
    ids.add(definition.id);
    for (const field of filterFields(definition)) {
      const owner = owners.get(field);
      if (owner !== undefined) {
        problems.push(`field "${field}" of "${definition.id}" is already used by ${owner}`);
      }
      owners.set(field, `"${definition.id}"`);
    }
  }
  return problems;
}

function isSet(value: SearchFormValues[SearchFormField]): boolean {
  if (typeof value === 'boolean') return value;
  return typeof value === 'string' && value.trim() !== '';
}

/** Whether the filter restricts the search (a range counts once). */
export function isFilterActive(definition: FilterDefinition, values: SearchFormValues): boolean {
  return filterFields(definition).some((field) => isSet(values[field]));
}

/** Number shown on the "More filters" badge. */
export function activeFilterCount(
  definitions: readonly FilterDefinition[],
  values: SearchFormValues,
): number {
  return definitions.filter((definition) => isFilterActive(definition, values)).length;
}

/** Empty value of a field (`false` for toggles, `''` otherwise). */
function emptyValue(definition: FilterDefinition): string | boolean {
  return definition.kind === 'toggle' ? false : '';
}

/** Values of the definitions' fields with every filter cleared. */
export function clearedFilterValues(definitions: readonly FilterDefinition[]): FilterValues {
  return Object.fromEntries(
    definitions.flatMap((definition) =>
      filterFields(definition).map((field) => [field, emptyValue(definition)]),
    ),
  ) as FilterValues;
}

/** The definitions' fields taken from `values` (the draft when the view opens). */
export function pickFilterValues(
  definitions: readonly FilterDefinition[],
  values: SearchFormValues,
): FilterValues {
  return Object.fromEntries(
    registryFields(definitions).map((field) => [field, values[field]]),
  ) as FilterValues;
}

/**
 * Validates a draft of the "More filters" view together with the rest of the form: the shared
 * search schema (bounds, Min ≤ Max, …) on the merged values plus each definition's own `validate`.
 * Returns only errors of the definitions' fields — errors of the main bar are the bar's business.
 */
export function validateFilterDraft(
  definitions: readonly FilterDefinition[],
  values: SearchFormValues,
  draft: FilterValues,
  meta?: SearchMeta,
): SearchFormError[] {
  const merged: SearchFormValues = { ...values, ...draft };
  const owned = new Set(registryFields(definitions));
  const result = validateSearchForm(merged, meta);
  const errors = 'errors' in result ? result.errors.filter((e) => owned.has(e.field)) : [];
  const seen = new Set(errors.map((e) => e.field));
  for (const definition of definitions) {
    const error = definition.validate?.(merged);
    if (error !== undefined && owned.has(error.field) && !seen.has(error.field)) {
      errors.push(error);
      seen.add(error.field);
    }
  }
  return errors;
}

/** Errors of the definitions' fields (to open the view on them, e.g. after a deep link). */
export function filterErrors(
  definitions: readonly FilterDefinition[],
  errors: readonly SearchFormError[],
): SearchFormError[] {
  const owned = new Set(registryFields(definitions));
  return errors.filter((error) => owned.has(error.field));
}

/**
 * `validateSearchForm` plus the definitions' own `validate` rules: what the search form runs on
 * submit and on a deep link. Errors stay one per field, in form order.
 */
export function validateWithFilters(
  definitions: readonly FilterDefinition[],
  values: SearchFormValues,
  meta?: SearchMeta,
): ReturnType<typeof validateSearchForm> {
  const result = validateSearchForm(values, meta);
  const errors = 'errors' in result ? [...result.errors] : [];
  const seen = new Set(errors.map((e) => e.field));
  for (const definition of definitions) {
    const error = definition.validate?.(values);
    if (error !== undefined && !seen.has(error.field)) {
      errors.push(error);
      seen.add(error.field);
    }
  }
  if (errors.length === 0) return result;
  const order = (error: SearchFormError) => SEARCH_FORM_FIELDS.indexOf(error.field);
  return { errors: errors.sort((a, b) => order(a) - order(b)) };
}
