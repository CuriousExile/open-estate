import { ListExecutionsCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  DuplicateReportService,
  DynamoDbDuplicateReportStore,
  DynamoDbMetricCounterStore,
  duplicateReviewDenied,
  DynamoDbTransactor,
  InvalidCursorError,
  manualSweepName,
  type Clock,
  type DuplicateSweepStarter,
  type KeyPage,
} from '@open-estate/core';
import {
  DuplicateReportsQuery,
  type ApiError,
  type DuplicateReportView,
} from '@open-estate/shared';
import { z } from 'zod';
import { readEnv } from '../env';
import { failure, fromResult, success, type Reply } from '../http';
import { defineRoute, type Route } from '../router';
import { withSignal } from './platform/platform-env';
import type { RouteGroup, RouteGroupContext } from './route-group';

// Duplikat-Erkennung for Plattform_Admins (duplicate-detection design: "Management_API",
// Req 10.2, 11.3–11.5): Agenturübergreifende_Treffer (`duplicate:review`) and the manual start of
// the Duplikat_Abgleich (`platform:operate`). Authorization, audit and counters live in the core
// `DuplicateReportService`; a 403 is audited as `access-denied` by the handler.

/** Environment of the group (wiring: the ManagementStack). */
export const DUPLICATES_ENV = {
  duplicateReportsTable: 'DUPLICATE_REPORTS_TABLE_NAME',
  metricCountersTable: 'METRIC_COUNTERS_TABLE_NAME',
  duplicateSweepStateMachineArn: 'DUPLICATE_SWEEP_STATE_MACHINE_ARN',
} as const;

/** What the routes need; bound to the request's abort signal. */
export interface DuplicateRouteDeps {
  service(
    signal: AbortSignal,
  ): Pick<
    DuplicateReportService<unknown>,
    'list' | 'dismiss' | 'startSweep' | 'getDetection' | 'setDetection'
  >;
}

const reportParams = z.object({ reportId: z.string() });

/** Report ids are sha256 hex; anything else cannot exist. */
const REPORT_ID = /^[0-9a-f]{64}$/;

const invalidPageToken = (): ApiError => ({
  code: 'INVALID_PAGE_TOKEN',
  message: 'Invalid page token',
  field: 'pageToken',
});

const toApiPage = (page: KeyPage<DuplicateReportView>) => ({
  items: page.items,
  ...(page.nextCursor !== undefined && { nextPageToken: page.nextCursor }),
});

export function createDuplicateRoutes(deps: DuplicateRouteDeps): Route[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/platform/duplicate-reports',
      query: DuplicateReportsQuery,
      async handle({ principal, query, signal }): Promise<Reply> {
        try {
          const result = await deps.service(signal).list(
            principal,
            {
              state: query.state,
              ...(query.agencyId !== undefined && { agencyId: query.agencyId }),
            },
            {
              limit: query.pageSize,
              ...(query.pageToken !== undefined && { cursor: query.pageToken }),
            },
          );
          return result.ok ? success(200, toApiPage(result.value)) : failure(result.error);
        } catch (error) {
          if (error instanceof InvalidCursorError) return failure(invalidPageToken());
          throw error;
        }
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/platform/duplicate-reports/{reportId}/dismiss',
      params: reportParams,
      async handle({ principal, params: { reportId }, signal }) {
        // The permission decides before the id, so others learn nothing about ids (Req 11.4).
        const denied = duplicateReviewDenied(principal);
        if (denied !== null) return failure(denied);
        if (!REPORT_ID.test(reportId)) {
          return failure({ code: 'NOT_FOUND', message: `Duplicate report ${reportId} not found` });
        }
        return fromResult(200, await deps.service(signal).dismiss(principal, reportId));
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/platform/duplicate-sweeps',
      async handle({ principal, signal }) {
        return fromResult(202, await deps.service(signal).startSweep(principal));
      },
    }),
    // Ein/Aus of the Duplikat-Erkennung (design: "Ein- und Ausschalten").
    defineRoute({
      method: 'GET',
      path: '/platform/duplicate-detection',
      async handle({ principal, signal }) {
        return fromResult(200, await deps.service(signal).getDetection(principal));
      },
    }),
    defineRoute({
      method: 'PUT',
      path: '/platform/duplicate-detection',
      async handle({ principal, body, signal }) {
        return fromResult(200, await deps.service(signal).setDetection(principal, body));
      },
    }),
  ];
}

/**
 * Starts the `DuplicateSweep` state machine unless an execution is running (Req 10.2). Two
 * concurrent starts may both see none; the later execution then finds the index already fresh.
 */
export class StepFunctionsDuplicateSweepStarter implements DuplicateSweepStarter {
  private readonly client: Pick<SFNClient, 'send'>;
  private readonly stateMachineArn: string;
  private readonly clock: Clock;

  constructor(options: { client: Pick<SFNClient, 'send'>; stateMachineArn: string; clock: Clock }) {
    this.client = options.client;
    this.stateMachineArn = options.stateMachineArn;
    this.clock = options.clock;
  }

  async start(): Promise<{ executionName: string; alreadyRunning: boolean }> {
    const running = await this.client.send(
      new ListExecutionsCommand({
        stateMachineArn: this.stateMachineArn,
        statusFilter: 'RUNNING',
        maxResults: 1,
      }),
    );
    const current = running.executions?.[0]?.name;
    if (current !== undefined) return { executionName: current, alreadyRunning: true };
    const name = manualSweepName(this.clock());
    await this.client.send(
      new StartExecutionCommand({ stateMachineArn: this.stateMachineArn, name, input: '{}' }),
    );
    return { executionName: name, alreadyRunning: false };
  }
}

/** Production wiring from {@link DUPLICATES_ENV}. Throws `ConfigError`. */
export function duplicateDepsFromEnv(
  { env, clients, shared }: RouteGroupContext,
  sfn: SFNClient = new SFNClient({}),
): DuplicateRouteDeps {
  const config = readEnv(env, DUPLICATES_ENV);
  return {
    service(signal) {
      const dynamo = withSignal(clients.dynamo, signal);
      return new DuplicateReportService({
        reports: new DynamoDbDuplicateReportStore({
          client: dynamo,
          tableName: config.duplicateReportsTable,
        }),
        counters: new DynamoDbMetricCounterStore({
          client: dynamo,
          tableName: config.metricCountersTable,
        }),
        transactor: new DynamoDbTransactor({ client: dynamo }),
        audit: shared.audit,
        clock: shared.clock,
        starter: new StepFunctionsDuplicateSweepStarter({
          client: withSignal(sfn, signal),
          stateMachineArn: config.duplicateSweepStateMachineArn,
          clock: shared.clock,
        }),
        ...(shared.duplicateDetection !== undefined && { detection: shared.duplicateDetection }),
      });
    },
  };
}

export function createDuplicateRouteGroup(sfn?: SFNClient): RouteGroup {
  return {
    name: 'duplicates',
    create: (context) => createDuplicateRoutes(duplicateDepsFromEnv(context, sfn)),
  };
}

export const duplicateRoutes: RouteGroup = createDuplicateRouteGroup();
