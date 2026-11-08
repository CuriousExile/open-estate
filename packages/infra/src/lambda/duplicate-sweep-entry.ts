// Lambda entry of the Duplikat_Abgleich as deployed by the ManagementStack: the task handler of
// the `DuplicateSweep` state machine (`@open-estate/management`). Not re-exported (module-level
// init).
import { createDuplicateSweepLambda } from '@open-estate/management';

export const handler = createDuplicateSweepLambda(process.env);
