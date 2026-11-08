// k6 load test of the Duplikat_Prüfung on creation (duplicate-detection task 13.3, Req 5.7):
// `POST /listings` of the Management_API with the bodies of one file, at a constant rate.
//
//   k6 run -e MANAGEMENT_URL=https://<id>.execute-api.<region>.amazonaws.com/v1 \
//     -e TOKEN=oem_<keyId>_<secret> -e BODIES_FILE=../out/duplicates/probe.json \
//     k6/management-create.js
//
// Env: MANAGEMENT_URL and TOKEN (a machine access with `listing:write`) are required;
// BODIES_FILE (relative to this script), RATE (default 5 per second, below the Management_API's
// default rate limit of the actor), DURATION (default: one pass over the file at RATE).
/* global __ENV, open */
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';

const BASE = (__ENV.MANAGEMENT_URL || '').replace(/\/+$/, '');
const TOKEN = __ENV.TOKEN || '';
const BODIES_FILE = __ENV.BODIES_FILE || '../out/duplicates/probe.json';
const RATE = Number(__ENV.RATE || 5);

if (!BASE) throw new Error('MANAGEMENT_URL is required');
if (!TOKEN) throw new Error('TOKEN (machine access credential) is required');

const BODIES = new SharedArray('bodies', () => JSON.parse(open(BODIES_FILE)));
if (BODIES.length === 0) throw new Error(`No bodies in ${BODIES_FILE}`);
const DURATION = __ENV.DURATION || `${Math.ceil(BODIES.length / RATE)}s`;

export const options = {
  scenarios: {
    create: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(5, RATE * 2),
      maxVUs: Math.max(20, RATE * 10),
    },
  },
  thresholds: {
    checks: ['rate>0.99'],
  },
};

export default function () {
  const body = BODIES[exec.scenario.iterationInTest % BODIES.length];
  const response = http.post(`${BASE}/listings`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    tags: { name: 'POST /listings' },
  });
  check(response, { 'status 201': (r) => r.status === 201 });
}
