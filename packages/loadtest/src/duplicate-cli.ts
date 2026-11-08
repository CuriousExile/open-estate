// Writes the request bodies of the duplicate load test (see `duplicate-load.ts` and the README):
//
//   npm run generate:duplicates --workspace @open-estate/loadtest -- [--out out/duplicates]
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  crowdBodies,
  DEFAULT_CROWD_SIZE,
  DEFAULT_PROBE_COUNT,
  isolatedBodies,
  probeBodies,
  requiredSegmentRate,
} from './duplicate-load';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const out = path.resolve(process.cwd(), argument('out', 'out/duplicates'));
const crowd = Number(argument('crowd', String(DEFAULT_CROWD_SIZE)));
const probes = Number(argument('probes', String(DEFAULT_PROBE_COUNT)));
mkdirSync(out, { recursive: true });
const files = {
  'crowd.json': crowdBodies(crowd),
  'probe.json': probeBodies(probes, 2, crowd),
  'isolated.json': isolatedBodies(probes),
};
for (const [name, bodies] of Object.entries(files)) {
  writeFileSync(path.join(out, name), JSON.stringify(bodies));
  console.log(`${bodies.length} bodies → ${path.join(out, name)}`);
}
const rate = requiredSegmentRate(1_000_000, 8, 4);
console.log(
  `Duplikat_Abgleich: 1,000,000 listings in 4 h with 8 segments need ${rate.toFixed(1)} ` +
    'listings/s per segment and phase.',
);
