// Lambda entry for the hourly overdue check of deletion requests (handler: `overdue-check.handler`,
// invoked by the scheduler of 14.10). Built once at init; missing configuration aborts the init
// with a ConfigError naming the variables (Req 9.4).
import { createOverdueCheckFromEnv } from './deletion';

const check = createOverdueCheckFromEnv(process.env);

export const handler = async () => {
  const result = await check();
  console.log(JSON.stringify({ event: 'deletion.overdue-check', ...result }));
  return result;
};
