import { createLogger } from '@open-estate/core';

// Module-scope Powertools logger of the management Lambda (one per instance).

export const MANAGEMENT_SERVICE_NAME = 'open-estate-management';

export const logger = createLogger(MANAGEMENT_SERVICE_NAME);
