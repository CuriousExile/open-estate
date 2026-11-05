// The audit log of the admin operations lives in core (`AdminOperations`); re-exported under the
// Admin_API's names.
export {
  ADMIN_AUDIT_CATEGORIES as AUDIT_CATEGORIES,
  AUDIT_LOG_PARTITION_KEY,
  AUDIT_LOG_SORT_KEY,
  DynamoDbAdminAuditLog as DynamoDbAuditLog,
  InMemoryAdminAuditLog as InMemoryAuditLog,
  type AdminAuditCategory as AuditCategory,
  type AdminAuditEntry as AuditEntry,
  type AdminAuditLog as AuditLog,
  type DynamoDbAdminAuditLogOptions as DynamoDbAuditLogOptions,
} from '@open-estate/core';
