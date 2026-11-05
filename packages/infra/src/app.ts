// CDK app entry (`cdk.json` → `node dist/app.js`). Select the environment with `-c env=<name>` (default `dev`).
// Account/region come from the CLI profile when deploying; without credentials the stacks stay
// environment-agnostic, so `cdk synth` needs no AWS access. The wiring lives in `platform.ts`.
import { App } from 'aws-cdk-lib';
import { buildPlatform } from './platform';

const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'];

buildPlatform(new App(), account && region ? { account, region } : undefined);
