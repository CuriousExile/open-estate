import type { z } from 'zod';
import { Area, formatDecimal, Money } from '../money';
import { LISTING_BOUNDS } from './listing';

// JSON Schema rendering of the request side (`io: 'input'`), shared by the OpenAPI document of the
// Search_API and the MCP tool input schemas so both advertise identical parameter schemas
// (Req 3.2, 19.2).

type OverrideContext = Parameters<NonNullable<z.core.ToJSONSchemaParams['override']>>[0];

/** Decimal-string schemas with their bounds in currency units resp. m² (Req 3.2). */
const DECIMAL_SCHEMAS = new Map<z.core.$ZodType, { description: string; min: string; max: string }>(
  [
    [
      Money,
      {
        description: 'Amount as decimal string in currency units, at most two fraction digits',
        min: formatDecimal(LISTING_BOUNDS.money.minMinor),
        max: formatDecimal(LISTING_BOUNDS.money.maxMinor),
      },
    ],
    [
      Area,
      {
        description: 'Area in m² as decimal string, at most two fraction digits',
        min: formatDecimal(LISTING_BOUNDS.area.minMinor),
        max: formatDecimal(LISTING_BOUNDS.area.maxMinor),
      },
    ],
  ],
);

/**
 * `override` for `z.toJSONSchema(…, { io: 'input' })` and `zod-openapi`:
 * - copies defaults of preprocessed fields, which Zod omits in input mode (`pageSize = 20`);
 * - adds the numeric range of decimal strings (`Money`, `Area`), which a string schema cannot
 *   express, as `x-minimum`/`x-maximum` plus a description.
 */
export function requestSchemaOverride({ zodSchema, jsonSchema }: OverrideContext): void {
  const def = zodSchema._zod.def;
  if (def.type === 'default' && jsonSchema.default === undefined) {
    jsonSchema.default = (def as z.core.$ZodDefaultDef).defaultValue as never;
  }
  const decimal = DECIMAL_SCHEMAS.get(zodSchema);
  if (decimal !== undefined) {
    jsonSchema.description = `${decimal.description} (${decimal.min} to ${decimal.max})`;
    jsonSchema['x-minimum'] = decimal.min;
    jsonSchema['x-maximum'] = decimal.max;
  }
}
