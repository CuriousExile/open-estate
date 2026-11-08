import {
  authorize,
  DuplicateDetectionRequest,
  err,
  ok,
  toApiErrors,
  type ApiError,
  type DuplicateDetectionView,
  type DuplicateReportView,
  type Principal,
  type Result,
} from '@open-estate/shared';
import type { Clock } from '../access/ttl-cache';
import type { AuditService } from '../management/audit-service';
import type { KeyPage, KeyPageRequest } from '../management/key-page';
import type { MetricCounterStore } from '../management/metric-counter-store';
import type { Transactor } from '../management/transaction';
import type { DuplicateDetectionSetting } from './duplicate-detection-setting';
import type {
  DuplicateReport,
  DuplicateReportFilter,
  DuplicateReportStore,
} from './duplicate-report-store';
import { openReportsDelta } from './duplicate-sweep';

// Review of Agenturübergreifender_Treffer by Plattform_Admins (duplicate-detection Req 11.3–11.5):
// list by state and agency, dismiss. Only `duplicate:review` may do either; it is held by the
// Plattform_Admin role alone and cannot be granted to machine access, so every agency actor and
// every machine access gets `FORBIDDEN` without any data (Req 11.4).

export const DUPLICATE_REVIEW = 'duplicate:review';

/** Attempts of a dismissal that races with the Duplikat_Abgleich writing the same Treffer. */
const DISMISS_ATTEMPTS = 3;

/** Starts a Duplikat_Abgleich unless one is running (Req 10.2). */
export interface DuplicateSweepStarter {
  start(): Promise<{ executionName: string; alreadyRunning: boolean }>;
}

export interface DuplicateReportServiceDeps<Op> {
  reports: DuplicateReportStore<Op>;
  counters: Pick<MetricCounterStore<Op>, 'addOp'>;
  transactor: Transactor<Op>;
  audit: Pick<AuditService, 'append'>;
  clock: Clock;
  /** Step Functions in AWS, an in-process run locally. */
  starter: DuplicateSweepStarter;
  /**
   * Ein/Aus of the Duplikat-Erkennung (design: "Ein- und Ausschalten"). Without it the detection
   * counts as always on and `PUT /platform/duplicate-detection` is not available.
   */
  detection?: DuplicateDetectionSetting;
}

/** API view of a stored Treffer: without revision and run id. */
export function toDuplicateReportView(report: DuplicateReport): DuplicateReportView {
  return {
    reportId: report.reportId,
    listingA: report.listingA,
    listingB: report.listingB,
    ...(report.agencyA !== undefined && { agencyA: report.agencyA }),
    ...(report.agencyB !== undefined && { agencyB: report.agencyB }),
    score: report.score,
    reasons: [...report.reasons],
    state: report.state,
    firstSeenAt: report.firstSeenAt,
    lastSeenAt: report.lastSeenAt,
    ...(report.dismissedAt !== undefined && { dismissedAt: report.dismissedAt }),
  };
}

const forbidden = (): ApiError => ({
  code: 'FORBIDDEN',
  message: `Missing permission ${DUPLICATE_REVIEW}`,
});

const reportNotFound = (reportId: string): ApiError => ({
  code: 'NOT_FOUND',
  message: `Duplicate report ${reportId} not found`,
});

/** Operator check of `POST /platform/duplicate-sweeps`: a user with `platform:operate`. */
function mayOperate(principal: Principal): principal is Extract<Principal, { kind: 'user' }> {
  return (
    principal.kind === 'user' && authorize(principal, 'platform:operate', undefined) === 'ALLOW'
  );
}

const operateForbidden = (): ApiError => ({
  code: 'FORBIDDEN',
  message: 'Missing permission platform:operate',
});

const detectionDisabled = (): ApiError => ({
  code: 'DUPLICATE_DETECTION_DISABLED',
  message: 'Duplicate detection is switched off; switch it on to run the duplicate check.',
});

const userActor = (principal: Extract<Principal, { kind: 'user' }>) => ({
  kind: 'user' as const,
  userId: principal.userId,
  displayName: principal.displayName,
});

/** Reviewer check: a user with `duplicate:review` (the Plattform_Admin). */
function mayReview(principal: Principal): boolean {
  return principal.kind === 'user' && authorize(principal, DUPLICATE_REVIEW, undefined) === 'ALLOW';
}

/** `FORBIDDEN` for every principal without `duplicate:review`, else `null` (Req 11.4). */
export function duplicateReviewDenied(principal: Principal): ApiError | null {
  return mayReview(principal) ? null : forbidden();
}

export class DuplicateReportService<Op> {
  private readonly deps: DuplicateReportServiceDeps<Op>;

  constructor(deps: DuplicateReportServiceDeps<Op>) {
    this.deps = deps;
  }

  /** `GET /platform/duplicate-reports` (Req 11.3): by descending score. */
  async list(
    principal: Principal,
    filter: DuplicateReportFilter,
    page: KeyPageRequest,
  ): Promise<Result<KeyPage<DuplicateReportView>, ApiError>> {
    if (!mayReview(principal)) return err(forbidden());
    const found = await this.deps.reports.list(filter, page);
    return ok({ ...found, items: found.items.map(toDuplicateReportView) });
  }

  /**
   * `POST /platform/duplicate-reports/{reportId}/dismiss` (Req 11.5): the Treffer becomes
   * `DISMISSED` and stays so while both listings exist. Dismissing a dismissed Treffer succeeds
   * without a change.
   */
  async dismiss(
    principal: Principal,
    reportId: string,
  ): Promise<Result<DuplicateReportView, ApiError>> {
    if (!mayReview(principal) || principal.kind !== 'user') return err(forbidden());
    const actor = {
      kind: 'user' as const,
      userId: principal.userId,
      displayName: principal.displayName,
    };
    const target = `duplicate-report/${reportId}`;
    for (let attempt = 0; attempt < DISMISS_ATTEMPTS; attempt += 1) {
      const report = await this.deps.reports.get(reportId);
      if (report === null) return err(reportNotFound(reportId));
      if (report.state === 'DISMISSED') return ok(toDuplicateReportView(report));
      const next: DuplicateReport = {
        ...report,
        state: 'DISMISSED',
        dismissedAt: new Date(this.deps.clock()).toISOString(),
      };
      const written = await this.deps.transactor.transact([
        this.deps.reports.putOp(next, report),
        ...(report.state === 'OPEN' ? [this.deps.counters.addOp(openReportsDelta(-1))] : []),
      ]);
      if (!written.ok) continue;
      await this.deps.audit.append({
        category: 'management',
        actor,
        action: 'duplicate-report.dismiss',
        target,
        result: 'SUCCESS',
      });
      return ok(toDuplicateReportView(next));
    }
    return err({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The duplicate report is being updated. Please retry later.',
    });
  }

  /**
   * `POST /platform/duplicate-sweeps` (Req 10.2): starts a Duplikat_Abgleich unless one is
   * running; then its execution name is returned instead.
   */
  async startSweep(
    principal: Principal,
  ): Promise<Result<{ executionName: string; alreadyRunning: boolean }, ApiError>> {
    if (!mayOperate(principal)) return err(operateForbidden());
    // Switched off, a run would end right after its start (design: "Ein- und Ausschalten").
    if (this.deps.detection !== undefined && !(await this.deps.detection.load())) {
      return err(detectionDisabled());
    }
    return ok(await this.start(principal));
  }

  /** `GET /platform/duplicate-detection`: whether the Duplikat-Erkennung runs. */
  async getDetection(principal: Principal): Promise<Result<DuplicateDetectionView, ApiError>> {
    if (!mayOperate(principal)) return err(operateForbidden());
    const detection = this.deps.detection;
    return ok({ enabled: detection === undefined ? true : await detection.load() });
  }

  /**
   * `PUT /platform/duplicate-detection` (design: "Ein- und Ausschalten"): switches the
   * Duplikat-Erkennung for the whole platform. Switching it on starts a Duplikat_Abgleich, which
   * rebuilds the Duplikat_Index the writes did not maintain meanwhile and renews every
   * Markierung; if that start fails the setting stays and the answer has no `sweep`.
   */
  async setDetection(
    principal: Principal,
    body: unknown,
  ): Promise<Result<DuplicateDetectionView, ApiError[]>> {
    if (!mayOperate(principal)) return err([operateForbidden()]);
    const parsed = DuplicateDetectionRequest.safeParse(body);
    if (!parsed.success) return err(toApiErrors(parsed.error.issues));
    const detection = this.deps.detection;
    if (detection === undefined) {
      return err([
        { code: 'SERVICE_UNAVAILABLE', message: 'Duplicate detection cannot be switched here' },
      ]);
    }
    const { enabled } = parsed.data;
    const before = await detection.load();
    if (before !== enabled) await detection.setEnabled(enabled);
    await this.deps.audit.append({
      category: 'management',
      actor: userActor(principal),
      action: enabled ? 'duplicate-detection.enable' : 'duplicate-detection.disable',
      target: 'platform/duplicate-detection',
      result: before === enabled ? 'UNCHANGED' : 'SUCCESS',
    });
    if (!enabled || before) return ok({ enabled });
    try {
      return ok({ enabled, sweep: await this.start(principal) });
    } catch {
      // The daily run or a manual start (`POST /platform/duplicate-sweeps`) catches up.
      return ok({ enabled });
    }
  }

  private async start(
    principal: Extract<Principal, { kind: 'user' }>,
  ): Promise<{ executionName: string; alreadyRunning: boolean }> {
    const started = await this.deps.starter.start();
    await this.deps.audit.append({
      category: 'management',
      actor: userActor(principal),
      action: 'duplicate-sweep.start',
      target: `duplicate-sweep/${started.executionName}`,
      result: started.alreadyRunning ? 'ALREADY_RUNNING' : 'SUCCESS',
    });
    return started;
  }
}

/** Execution name of a run started via the API: `manual-{UTC timestamp}` (Req 10.2). */
export function manualSweepName(epochMs: number): string {
  return `manual-${new Date(epochMs).toISOString().replace(/[-:]/g, '').replace('.', '-')}`;
}

export interface InProcessSweepStarterOptions {
  /** The run; resolves when it is done. */
  run(sweepId: string, startedAt: string): Promise<unknown>;
  clock: Clock;
}

/**
 * Runs the Duplikat_Abgleich in this process (dev server): one run at a time, like the state
 * machine's running-execution check. Failures are left to `run`, which logs them.
 */
export class InProcessDuplicateSweepStarter implements DuplicateSweepStarter {
  private readonly options: InProcessSweepStarterOptions;
  private running: { name: string; done: Promise<void> } | undefined;

  constructor(options: InProcessSweepStarterOptions) {
    this.options = options;
  }

  async start(): Promise<{ executionName: string; alreadyRunning: boolean }> {
    if (this.running !== undefined) {
      return { executionName: this.running.name, alreadyRunning: true };
    }
    const now = this.options.clock();
    const name = manualSweepName(now);
    const done = this.options
      .run(name, new Date(now).toISOString())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.running = undefined;
      });
    this.running = { name, done };
    return { executionName: name, alreadyRunning: false };
  }

  /** Resolves when no run is in progress (tests, shutdown). */
  async idle(): Promise<void> {
    await this.running?.done;
  }
}
