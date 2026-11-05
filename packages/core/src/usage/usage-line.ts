import { EntityId } from '@open-estate/shared';
import { z } from 'zod';

// Usage log line of the API and MCP Lambdas (design: "UsageAggregator", Req 13.4): one line per
// successful search page (`impression`) or detail call (`detail`). The line carries only listing
// and agency ids — no IP address, no API key, no request data — and is forwarded by a
// CloudWatch Logs subscription filter to the UsageAggregator.

export const USAGE_KINDS = ['detail', 'impression'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** One listing shown in a response; `agencyId` is absent for listings without agency. */
export interface UsageItem {
  id: string;
  agencyId?: string;
}

/** Records usage; must never fail or slow down the request. */
export interface UsageRecorder {
  record(kind: UsageKind, items: readonly UsageItem[]): void;
}

export const NO_USAGE: UsageRecorder = { record: () => undefined };

export const UsageLine = z.object({
  usage: z.object({
    kind: z.enum(USAGE_KINDS),
    items: z.array(z.object({ id: EntityId, agencyId: EntityId.optional() })),
  }),
});
export type UsageLine = z.infer<typeof UsageLine>;

/**
 * Subscription filter pattern that forwards only usage lines (wiring: task 12.2). EMF lines and
 * Powertools log lines have no top-level `usage` attribute.
 */
export const USAGE_LOG_FILTER_PATTERN = '{ $.usage.kind = * }';

/** The usage line as JSON, built from ids only (copies `id` and `agencyId`, nothing else). */
export function formatUsageLine(kind: UsageKind, items: readonly UsageItem[]): string {
  const line: UsageLine = {
    usage: {
      kind,
      items: items.map(({ id, agencyId }) => (agencyId === undefined ? { id } : { id, agencyId })),
    },
  };
  return JSON.stringify(line);
}

/**
 * Writes one usage line per call to stdout (raw JSON, like EMF), so it reaches the Lambda's log
 * group unchanged. Calls without items write nothing; write errors are swallowed.
 */
export function createStdoutUsageRecorder(
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
): UsageRecorder {
  return {
    record(kind, items) {
      if (items.length === 0) return;
      try {
        write(`${formatUsageLine(kind, items)}\n`);
      } catch {
        // Usage counting is best effort; the response is never affected.
      }
    },
  };
}
