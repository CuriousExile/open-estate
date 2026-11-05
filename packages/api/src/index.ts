// @open-estate/api: Search API Lambda adapter. Lambda entry points (e.g. `listings.ts`) are
// deliberately not re-exported, so importing the package never triggers handler init.
export * from './cors';
export * from './discovery';
export * from './listings-handler';
export * from './listings-lambda';
export * from './listing-detail-handler';
export * from './locations-handler';
export * from './observability';
export * from './router';
