// @open-estate/admin: Admin API Lambda adapter. The Lambda entries (`admin.ts`,
// `deletion-task.ts`, `overdue-check.ts`) are deliberately not re-exported, so importing the package never triggers
// handler init.
export * from './audit-log';
export * from './admin-handler';
export * from './admin-lambda';
export * from './deletion-routes';
export * from './deletion';
