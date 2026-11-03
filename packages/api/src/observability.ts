import { createLogger, createMetrics } from '@open-estate/core';

// Module-scope Powertools instances of the Search_API Lambda (one per instance, as recommended
// by Powertools). Tests spy on `logger` or inject their own `Metrics` into the handler factory.

export const API_SERVICE_NAME = 'open-estate-api';

export const logger = createLogger(API_SERVICE_NAME);
export const metrics = createMetrics(API_SERVICE_NAME);
