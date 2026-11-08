import { test as setup } from '@playwright/test';
import { resetDemo } from '../../support/demo-server';

// Every run starts from the seed, also on a reused demo (BROWSER_TEST_REUSE_SERVER=1).
setup('reset the demo to its seed', async ({ request }) => {
  await resetDemo(request);
});
