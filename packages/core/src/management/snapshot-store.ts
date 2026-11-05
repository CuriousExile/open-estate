import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { CONTENT_FIELDS, type ListingContent } from '@open-estate/shared';

// Content snapshots of the version history in S3 bucket `VersionSnapshots` (design:
// "Versions-Snapshots"): content-addressed per listing, so equal contents (status versions,
// restores) are stored once. Encryption (SSE-KMS) is the bucket default; no bucket versioning,
// so deleting the prefix `listings/{id}/` removes all contents (Req 9.2).

/**
 * Object key `listings/{id}/{contentHash}.json`. The id is URI-encoded so an id containing `/`
 * cannot reach into another listing's prefix.
 */
export function snapshotKey(listingId: string, contentHash: string): string {
  return `${snapshotPrefix(listingId)}${contentHash}.json`;
}

/** Prefix of all snapshots of one listing (deletion, Req 9.2). */
export function snapshotPrefix(listingId: string): string {
  return `listings/${encodeURIComponent(listingId)}/`;
}

/**
 * Serialized snapshot: the Listing_Inhalt in the internal representation. Restricted to the
 * content fields (as `contentHash`), so passing a full listing stores exactly the hashed content.
 */
export function serializeSnapshot(content: ListingContent): string {
  const source = content as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(CONTENT_FIELDS.map((field) => [field, source[field]])));
}

export interface PutSnapshotResult {
  /** `false` = an object with this hash already existed (deduplicated). */
  created: boolean;
  /** UTF-8 size of the serialized snapshot. */
  bytes: number;
}

export interface SnapshotStore {
  /** Stores the content under its hash unless it exists. */
  put(listingId: string, contentHash: string, content: ListingContent): Promise<PutSnapshotResult>;
  /** Stored content, or `null` if no snapshot has this hash. */
  get(listingId: string, contentHash: string): Promise<ListingContent | null>;
}

/** Fake for tests; keeps the serialized form, so reads return a fresh copy like S3. */
export class InMemorySnapshotStore implements SnapshotStore {
  private readonly objects = new Map<string, string>();

  async put(listingId: string, contentHash: string, content: ListingContent) {
    const key = snapshotKey(listingId, contentHash);
    const body = serializeSnapshot(content);
    const created = !this.objects.has(key);
    if (created) this.objects.set(key, body);
    return { created, bytes: Buffer.byteLength(body, 'utf8') };
  }

  async get(listingId: string, contentHash: string): Promise<ListingContent | null> {
    const body = this.objects.get(snapshotKey(listingId, contentHash));
    return body === undefined ? null : (JSON.parse(body) as ListingContent);
  }

  /** Deletes every object under `prefix` (deletion of a listing, Req 9.2). */
  removePrefix(prefix: string): void {
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) this.objects.delete(key);
    }
  }

  /** Stored object keys (for assertions in tests). */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

export interface S3SnapshotStoreOptions {
  client: S3Client;
  /** `VersionSnapshots` bucket. */
  bucketName: string;
}

const httpStatus = (error: unknown): number | undefined =>
  (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

/**
 * `PutObject` with `If-None-Match: *`: S3 answers `412 PreconditionFailed` if the key exists,
 * which here means "already stored" (same hash = same content). Snapshots are written before the
 * listing transaction; a failed transaction leaves at most an unreferenced object under the
 * listing's prefix, which is removed with the listing.
 */
export class S3SnapshotStore implements SnapshotStore {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor({ client, bucketName }: S3SnapshotStoreOptions) {
    this.client = client;
    this.bucketName = bucketName;
  }

  async put(listingId: string, contentHash: string, content: ListingContent) {
    const body = serializeSnapshot(content);
    const bytes = Buffer.byteLength(body, 'utf8');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: snapshotKey(listingId, contentHash),
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
      return { created: true, bytes };
    } catch (error) {
      if (httpStatus(error) === 412) return { created: false, bytes };
      throw error;
    }
  }

  async get(listingId: string, contentHash: string): Promise<ListingContent | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: snapshotKey(listingId, contentHash) }),
      );
      if (out.Body === undefined) return null;
      // Not re-validated: the `ListingContent` schema parses the API representation, snapshots
      // hold the internal one and are only written by this store from validated content.
      return JSON.parse(await out.Body.transformToString('utf-8')) as ListingContent;
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return null;
      throw error;
    }
  }
}
