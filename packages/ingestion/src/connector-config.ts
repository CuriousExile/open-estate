import { z } from 'zod';
import { CONNECTOR_TYPES } from './connector';

/** Object key of the connector registration file in the private config bucket. */
export const CONNECTORS_CONFIG_KEY = 'connectors.json';

export const DEFAULT_TIMEOUT_SECONDS = 300;
/** Upper bound = Lambda maximum; the connector runs inside one Lambda invocation. */
export const MAX_TIMEOUT_SECONDS = 900;

/**
 * Connector ids double as source identifier and EventBridge Scheduler name
 * (max 64 chars), hence a conservative slug.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Secrets Manager secret name or ARN. */
const SECRET_REF = /^[A-Za-z0-9/_+=.@:-]{1,2048}$/;

const RATE = /^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$/;
const CRON = /^cron\((.+)\)$/;
const CRON_FIELD = /^[0-9A-Za-z*?,/#-]+$/;

/**
 * Syntactic check of a recurring EventBridge Scheduler expression:
 * `rate(<n> <unit>)` with n ≥ 1 and singular unit exactly for n = 1, or
 * `cron(min hour day-of-month month day-of-week year)` with exactly one of
 * day-of-month / day-of-week set to `?`. One-time `at(...)` is not a schedule.
 */
export function isValidScheduleExpression(expression: string): boolean {
  const rate = RATE.exec(expression);
  if (rate) {
    const value = Number(rate[1]);
    const unit = rate[2] ?? '';
    return Number.isSafeInteger(value) && value >= 1 && (value === 1) === !unit.endsWith('s');
  }
  const cron = CRON.exec(expression);
  if (!cron) return false;
  const fields = (cron[1] ?? '').split(' ');
  if (fields.length !== 6 || !fields.every((f) => CRON_FIELD.test(f))) return false;
  const [minutes, hours, dayOfMonth, , dayOfWeek] = fields;
  if (minutes?.includes('?') || hours?.includes('?')) return false;
  return (dayOfMonth === '?') !== (dayOfWeek === '?');
}

export const connectorConfigSchema = z.strictObject({
  id: z.string().regex(SLUG, 'must be a lowercase slug of at most 64 characters'),
  type: z.enum(CONNECTOR_TYPES),
  /** Key of a module in the {@link ConnectorRegistry}, never a code path. */
  module: z.string().regex(SLUG, 'must be a lowercase slug of at most 64 characters'),
  enabled: z.boolean(),
  schedule: z
    .string()
    .refine(isValidScheduleExpression, 'must be an EventBridge rate(...) or cron(...) expression'),
  timeoutSeconds: z.int().min(1).max(MAX_TIMEOUT_SECONDS).default(DEFAULT_TIMEOUT_SECONDS),
  /** Connector-specific; validated against the module's own schema before `initialize`. */
  settings: z.unknown().default({}),
  secretRef: z
    .string()
    .regex(SECRET_REF, 'must be a Secrets Manager secret name or ARN')
    .optional(),
});

export type ConnectorConfig = z.output<typeof connectorConfigSchema>;

/** Content of `connectors.json`: a list of registrations with unique ids. */
export const connectorsFileSchema = z.array(connectorConfigSchema).superRefine((configs, ctx) => {
  const seen = new Set<string>();
  configs.forEach((config, index) => {
    if (seen.has(config.id)) {
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'duplicate connector id' });
    }
    seen.add(config.id);
  });
});

export type ConnectorsFile = z.output<typeof connectorsFileSchema>;
