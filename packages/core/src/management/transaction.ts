import {
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { err, ok, type Result } from '@open-estate/shared';

// Atomic multi-item writes across management stores (design: "Data Models", Admin invariants;
// "VersionedListingWriter"). Stores build backend-specific operations (`Op`), a `Transactor<Op>`
// applies them all-or-nothing. A service is generic over `Op`, so it runs unchanged against the
// in-memory fakes and DynamoDB; mixing fake and DynamoDB operations does not compile.

/** Labels of the operations whose condition failed; nothing was written. */
export interface TransactionConflict {
  readonly failed: readonly string[];
}

export type TransactionResult = Result<void, TransactionConflict>;

/**
 * Applies all operations or none. An operation carries a `label` (store default, e.g.
 * `membership.create`; override by spreading `{ ...op, label }`) that names it in a
 * {@link TransactionConflict}. Failed conditions are an expected result; anything else throws.
 */
export interface Transactor<Op> {
  transact(ops: readonly Op[]): Promise<TransactionResult>;
}

/** Maximum operations per DynamoDB `TransactWriteItems` call. */
export const MAX_TRANSACTION_OPS = 100;

// ---------------------------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------------------------

/**
 * Fake operation: `check` evaluates the condition against the current state, `apply` performs
 * the write. `target` (`table#key`) identifies the item; like DynamoDB, one transaction must not
 * touch an item twice.
 */
export interface InMemoryOp {
  readonly label: string;
  readonly target: string;
  check(): boolean;
  apply(): void;
}

/**
 * Transaction semantics of the fakes: every condition is checked against the state before the
 * transaction; only if all hold are all writes applied (synchronously, so no interleaving).
 */
export class InMemoryTransactor implements Transactor<InMemoryOp> {
  async transact(ops: readonly InMemoryOp[]): Promise<TransactionResult> {
    assertValidTransaction(ops.map((op) => op.target));
    const failed = ops.filter((op) => !op.check()).map((op) => op.label);
    if (failed.length > 0) return err({ failed });
    for (const op of ops) op.apply();
    return ok(undefined);
  }
}

function assertValidTransaction(targets: readonly string[]): void {
  if (targets.length > MAX_TRANSACTION_OPS) {
    throw new Error(`Transaction exceeds ${MAX_TRANSACTION_OPS} operations`);
  }
  const duplicate = targets.find((target, index) => targets.indexOf(target) !== index);
  if (duplicate !== undefined) throw new Error(`Transaction touches ${duplicate} twice`);
}

// ---------------------------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------------------------

export type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** One `Put`/`Update`/`Delete`/`ConditionCheck` entry of `TransactWriteItems`. */
export interface DynamoDbOp {
  readonly label: string;
  readonly item: TransactWriteItem;
}

const CONDITION_FAILED = 'ConditionalCheckFailed';

/**
 * Sends one `TransactWriteItems`. A `TransactionCanceledException` with at least one
 * `ConditionalCheckFailed` reason becomes a {@link TransactionConflict} with the labels at those
 * positions; other cancellations (e.g. `TransactionConflict` with a concurrent transaction,
 * throttling) and errors are rethrown.
 */
export class DynamoDbTransactor implements Transactor<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;

  constructor({ client }: { client: DynamoDBDocumentClient }) {
    this.client = client;
  }

  async transact(ops: readonly DynamoDbOp[]): Promise<TransactionResult> {
    if (ops.length === 0) return ok(undefined);
    if (ops.length > MAX_TRANSACTION_OPS) {
      throw new Error(`Transaction exceeds ${MAX_TRANSACTION_OPS} operations`);
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: ops.map((op) => op.item) }));
      return ok(undefined);
    } catch (error) {
      const codes = cancellationCodes(error);
      const failed = ops.filter((_, index) => codes?.[index] === CONDITION_FAILED);
      if (failed.length > 0) return err({ failed: failed.map((op) => op.label) });
      throw error;
    }
  }
}

/** Per-item cancellation codes of a `TransactionCanceledException`, otherwise `undefined`. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.map((reason) => reason.Code);
}

/** `true` if `error` is a failed condition of a single-item write. */
export function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}
