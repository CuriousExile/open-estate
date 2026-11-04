import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { systemClock, type Clock } from '@open-estate/core';
import { describeCriterion, type DeletionCriterion } from './deletion-model';
import { DynamoDbDeletionListingStore, type DeletionListingStore } from './deletion-listing-store';
import { DynamoDbDeletionRequestStore, type DeletionRequestStore } from './deletion-request-store';
import { DELETION_ENV, readEnv } from './deletion-task-handler';

/** A request counts as overdue once it is OPEN for longer than this (Req 18.10). */
export const DELETION_OVERDUE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Default page size for the `byStatus` query and for counting remaining listings of a source. */
export const OVERDUE_CHECK_PAGE_SIZE = 100;

/** Content of an overdue notification; key data only, no listing content (Req 18.8, 18.10). */
export interface OverdueDeletionNotice {
  requestId: string;
  criterion: DeletionCriterion;
  /** ISO-8601. */
  requestedAt: string;
  /** Listings matching the criterion that still exist. */
  remainingCount: number;
  /** IAM ARN of the requesting administrator (`requestedBy`); routing only, not message text. */
  adminArn: string;
}

/** Port for delivering an overdue notification to the requesting administrator. */
export interface OverdueDeletionNotifier {
  notify(notice: OverdueDeletionNotice): Promise<void>;
}

/** Fake for tests and in-process runs; records every notice. */
export class InMemoryOverdueDeletionNotifier implements OverdueDeletionNotifier {
  readonly sent: OverdueDeletionNotice[] = [];

  async notify(notice: OverdueDeletionNotice): Promise<void> {
    this.sent.push(structuredClone(notice));
  }
}

/** Human-readable message text; contains neither the admin ARN nor listing content. */
export function formatOverdueDeletionMessage(notice: OverdueDeletionNotice): string {
  const listings = notice.remainingCount === 1 ? 'listing is' : 'listings are';
  return (
    `Deletion request ${notice.requestId} (${describeCriterion(notice.criterion)}, requested ` +
    `${notice.requestedAt}) has not been fully executed within 24 hours: ` +
    `${notice.remainingCount} ${listings} not yet removed. The request stays OPEN.`
  );
}

export interface SnsOverdueDeletionNotifierOptions {
  client: SNSClient;
  topicArn: string;
}

/**
 * Publishes to one topic; the message attribute `adminArn` (String) lets each administrator's
 * subscription select its own requests via filter policy (design, infra 14.10).
 */
export class SnsOverdueDeletionNotifier implements OverdueDeletionNotifier {
  private readonly client: SNSClient;
  private readonly topicArn: string;

  constructor({ client, topicArn }: SnsOverdueDeletionNotifierOptions) {
    this.client = client;
    this.topicArn = topicArn;
  }

  async notify(notice: OverdueDeletionNotice): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Subject: 'Deletion request overdue',
        Message: formatOverdueDeletionMessage(notice),
        MessageAttributes: {
          adminArn: { DataType: 'String', StringValue: notice.adminArn },
          requestId: { DataType: 'String', StringValue: notice.requestId },
          remainingCount: { DataType: 'Number', StringValue: String(notice.remainingCount) },
        },
      }),
    );
  }
}

export interface OverdueDeletionCheckDeps {
  requests: DeletionRequestStore;
  listings: Pick<DeletionListingStore, 'find' | 'listBySource'>;
  notifier: OverdueDeletionNotifier;
  clock?: Clock;
  pageSize?: number;
}

export interface OverdueDeletionCheckResult {
  /** Overdue candidates returned by the `byStatus` query. */
  checked: number;
  notified: number;
  /** Executed in the meantime or already notified. */
  skipped: number;
  /** Notification or bookkeeping failed; retried by the next run. */
  failed: number;
}

export type OverdueDeletionCheck = () => Promise<OverdueDeletionCheckResult>;

/**
 * Hourly overdue check (Req 18.10): every request `OPEN` for longer than 24 h (strictly) is
 * reported once to its requesting administrator with the number of listings not yet removed; the
 * request stays `OPEN`. Dedup: `notifiedAt` is set after a successful notification and notified
 * requests are skipped afterwards — the requirement asks for a notification, not a reminder every
 * hour. A failed notification leaves `notifiedAt` unset, so the next run retries it; a failure
 * between publish and `markNotified` may cause one duplicate (at-least-once).
 *
 * Failures of single requests are logged (error class and request id only) and do not stop the
 * others; failures of the query itself propagate.
 */
export function createOverdueDeletionCheck(deps: OverdueDeletionCheckDeps): OverdueDeletionCheck {
  const clock = deps.clock ?? systemClock;
  const pageSize = deps.pageSize ?? OVERDUE_CHECK_PAGE_SIZE;

  async function countRemaining(criterion: DeletionCriterion): Promise<number> {
    if ('listingId' in criterion) {
      return (await deps.listings.find(criterion.listingId)) === null ? 0 : 1;
    }
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await deps.listings.listBySource(criterion.source, {
        limit: pageSize,
        ...(cursor !== undefined && { cursor }),
      });
      count += page.targets.length;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return count;
  }

  /** `true` if notified, `false` if skipped. */
  async function checkRequest(requestId: string, now: string): Promise<boolean> {
    // The GSI is eventually consistent: re-read before notifying.
    const record = await deps.requests.get(requestId);
    if (record?.status !== 'OPEN' || record.notifiedAt !== undefined) return false;
    await deps.notifier.notify({
      requestId,
      criterion: record.criterion,
      requestedAt: record.requestedAt,
      remainingCount: await countRemaining(record.criterion),
      adminArn: record.requestedBy,
    });
    await deps.requests.markNotified(requestId, now);
    return true;
  }

  return async () => {
    const nowMs = clock();
    const now = new Date(nowMs).toISOString();
    const cutoff = new Date(nowMs - DELETION_OVERDUE_AFTER_MS).toISOString();
    const result: OverdueDeletionCheckResult = { checked: 0, notified: 0, skipped: 0, failed: 0 };
    let cursor: string | undefined;
    do {
      const page = await deps.requests.listOpenRequestedBefore(cutoff, {
        limit: pageSize,
        ...(cursor !== undefined && { cursor }),
      });
      for (const requestId of page.requestIds) {
        result.checked += 1;
        try {
          if (await checkRequest(requestId, now)) result.notified += 1;
          else result.skipped += 1;
        } catch (cause) {
          result.failed += 1;
          console.error('Overdue deletion check: notification failed', {
            requestId,
            errorName: cause instanceof Error ? cause.name : typeof cause,
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  };
}

/** Environment variables of the overdue-check Lambda (set by the CDK stack, 14.10). */
export const OVERDUE_CHECK_ENV = {
  listingsTable: DELETION_ENV.listingsTable,
  deletionRequestsTable: DELETION_ENV.deletionRequestsTable,
  /** SNS topic for overdue notifications; subscriptions filter on attribute `adminArn`. */
  overdueTopicArn: 'OVERDUE_TOPIC_ARN',
} as const;

export interface OverdueCheckClients {
  dynamo?: DynamoDBDocumentClient;
  sns?: SNSClient;
}

/** Production check over DynamoDB and SNS; missing variables throw `ConfigError` (Req 9.4). */
export function createOverdueCheckFromEnv(
  env: NodeJS.ProcessEnv,
  clients: OverdueCheckClients = {},
): OverdueDeletionCheck {
  const config = readEnv(env, OVERDUE_CHECK_ENV);
  const dynamo = clients.dynamo ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sns = clients.sns ?? new SNSClient({});
  return createOverdueDeletionCheck({
    requests: new DynamoDbDeletionRequestStore({
      client: dynamo,
      tableName: config.deletionRequestsTable,
    }),
    listings: new DynamoDbDeletionListingStore({
      client: dynamo,
      listingsTable: config.listingsTable,
      deletionRequestsTable: config.deletionRequestsTable,
    }),
    notifier: new SnsOverdueDeletionNotifier({ client: sns, topicArn: config.overdueTopicArn }),
  });
}
