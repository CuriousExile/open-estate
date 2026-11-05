// k6 load test for the reference load (Req 2.4, 11.3): 50 req/s for 10 min, measured separately
// for search (`GET /listings`, page size 20) and detail (`GET /listings/{id}`).
//
//   k6 run -e BASE_URL=https://<api>/<stage> -e SCENARIO=search k6/api-load.js
//   k6 run -e BASE_URL=... -e SCENARIO=detail -e IDS_FILE=../out/ids.txt k6/api-load.js
//
// Env: BASE_URL (required), SCENARIO search|detail|all (default all: detail starts after search
// plus a pause, so the two never overlap), API_KEY (sent as `Authorization: Bearer`), IDS_FILE
// (relative to this script, default ../out/ids.txt), RATE (default 50), DURATION (default 10m).
/* global __ENV, open */
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const SCENARIO = __ENV.SCENARIO || 'all';
const RATE = Number(__ENV.RATE || 50);
const DURATION = __ENV.DURATION || '10m';
const IDS_FILE = __ENV.IDS_FILE || '../out/ids.txt';
const PAGE_SIZE = 20;
/** Pause between the search and detail runs of SCENARIO=all. */
const PAUSE_SECONDS = 30;
const P95_MS = 2000;

if (!BASE_URL) throw new Error('BASE_URL is required, e.g. -e BASE_URL=https://<api>/<stage>');
if (!['search', 'detail', 'all'].includes(SCENARIO)) {
  throw new Error(`SCENARIO must be search, detail or all, got ${SCENARIO}`);
}
const RUN_SEARCH = SCENARIO !== 'detail';
const RUN_DETAIL = SCENARIO !== 'search';

/** k6 duration string (`10m`, `1m30s`, `90s`, `1h`) → seconds. */
function durationSeconds(value) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || value === '') throw new Error(`Unsupported DURATION ${value}`);
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

// Filter values shared with the generator: its city pool and the default taxonomy.
const CITIES = new SharedArray('cities', () => JSON.parse(open('../src/cities.json')));
const GROUPS = new SharedArray(
  'groups',
  () => JSON.parse(open('../../shared/src/config/taxonomy.json')).groups,
);
const IDS = RUN_DETAIL
  ? new SharedArray('ids', () => open(IDS_FILE).split('\n').filter(Boolean))
  : [];
if (RUN_DETAIL && IDS.length === 0) throw new Error(`No listing ids in ${IDS_FILE}`);

const HEADERS = { Accept: 'application/json' };
if (__ENV.API_KEY) HEADERS.Authorization = `Bearer ${__ENV.API_KEY}`;

function arrivalRate(exec, startTime) {
  return {
    executor: 'constant-arrival-rate',
    exec,
    rate: RATE,
    timeUnit: '1s',
    duration: DURATION,
    startTime,
    preAllocatedVUs: RATE,
    maxVUs: RATE * 4,
    gracefulStop: '10s',
  };
}

const scenarios = {};
const thresholds = {};
if (RUN_SEARCH) {
  scenarios.search = arrivalRate('search', '0s');
  thresholds['http_req_duration{scenario:search}'] = [`p(95)<=${P95_MS}`];
  thresholds['checks{scenario:search}'] = ['rate>0.99'];
}
if (RUN_DETAIL) {
  const start = RUN_SEARCH ? `${durationSeconds(DURATION) + PAUSE_SECONDS}s` : '0s';
  scenarios.detail = arrivalRate('detail', start);
  thresholds['http_req_duration{scenario:detail}'] = [`p(95)<=${P95_MS}`];
  thresholds['checks{scenario:detail}'] = ['rate>0.99'];
}

export const options = {
  scenarios,
  thresholds,
  // Only status codes are checked; skipping bodies keeps k6 memory flat.
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const chance = (p) => Math.random() < p;

/** Varied search filters: offer type, city, rooms, price (only with offer type), group. */
function searchParams() {
  const params = [['pageSize', String(PAGE_SIZE)]];
  const offerType = pick(['SALE', 'RENT', null]);
  if (offerType) params.push(['offerType', offerType]);
  if (chance(0.8)) params.push(['city', pick(CITIES).city]);
  if (chance(0.5)) params.push(['roomsMin', String(pick([1, 2, 3, 4]))]);
  // Generated listings are EUR; explicit currency instead of relying on the configured default.
  const priceMax = { SALE: ['300000', '750000'], RENT: ['1000', '2500'] }[offerType];
  if (priceMax && chance(0.4)) params.push(['priceMax', pick(priceMax)], ['currency', 'EUR']);
  if (chance(0.3)) params.push(['group', pick(GROUPS).code]);
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export function search() {
  const res = http.get(`${BASE_URL}/listings?${searchParams()}`, {
    headers: HEADERS,
    tags: { name: 'GET /listings' },
  });
  check(res, { 'search status 200': (r) => r.status === 200 });
}

export function detail() {
  const res = http.get(`${BASE_URL}/listings/${encodeURIComponent(pick(IDS))}`, {
    headers: HEADERS,
    tags: { name: 'GET /listings/{id}' },
  });
  check(res, { 'detail status 200': (r) => r.status === 200 });
}
