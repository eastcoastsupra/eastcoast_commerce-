import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createSupplierRequestLane, SUPPLIER_REQUEST_POLICY } from '../src/turn14/request-lane.js';

function fixture() {
  let time = 0;
  const runtime = { now: () => time, sleep: async ms => { time += ms; } };
  return { runtime, lane: createSupplierRequestLane(runtime), get time() { return time; }, set time(value) { time = value; } };
}
async function start(lane, callback) {
  do { await lane.wait(); } while (!lane.tryStart());
  return callback();
}

test('the first attempt and every concurrent physical start obey the fixed lane interval', async () => {
  const f = fixture(), starts = [];
  assert.equal(f.lane.tryStart(), false);
  await Promise.all(Array.from({ length: 20 }, () => start(f.lane, () => { starts.push(f.time); })));
  assert.equal(starts[0], 1500);
  assert.ok(starts.every((at, i) => i === 0 || at - starts[i - 1] >= 1500));
  const nextProcess = createSupplierRequestLane(f.runtime);
  await start(nextProcess, () => starts.push(f.time));
  assert.equal(starts.at(-1) - starts.at(-2), 1500, 'sequential process restart must not create a burst');
});

test('two managed lanes remain below the owner ceiling in every inclusive hour', async () => {
  const f = fixture(), starts = [];
  for (let i = 0; i < 5000; i++) await start(f.lane, () => starts.push(f.time));
  let left = 0, maximum = 0;
  for (let right = 0; right < starts.length; right++) {
    while (starts[right] - starts[left] > 3600000) left++;
    maximum = Math.max(maximum, right - left + 1);
  }
  assert.equal(maximum, 2401);
  assert.equal(SUPPLIER_REQUEST_POLICY.accountHourlyCeiling, 4999);
  assert.equal(maximum * SUPPLIER_REQUEST_POLICY.managedLanes, 4802);
  assert.ok(maximum * SUPPLIER_REQUEST_POLICY.managedLanes <= SUPPLIER_REQUEST_POLICY.accountHourlyCeiling);
});

test('clock rollback fails closed rather than resetting the lane allowance', async () => {
  const f = fixture();
  await start(f.lane, () => {});
  f.time--;
  assert.throws(() => f.lane.tryStart(), /Invalid supplier request lane clock/u);
});

test('every supplier workflow shares its repository lane without cancellation', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const name of await readdir(directory)) {
    const source = await readFile(new URL(name, directory), 'utf8');
    if (!source.includes('TURN14_CLIENT_ID') || name === 'validate.yml') continue;
    assert.match(source, /concurrency:\s*\n\s+group: eastcoast-commerce-writes\s*\n\s+cancel-in-progress: false/u, name);
  }
});

import { Turn14Client } from '../src/turn14/client.js';
test('waiting for admission does not consume the HTTP timeout before the network starts', async () => {
  let time = 0, reads = 0;
  const lane = createSupplierRequestLane({ now: () => time, sleep: async ms => {
    await new Promise(resolve => setTimeout(resolve, 25)); time += ms;
  } });
  const client = new Turn14Client({ clientId: 'synthetic', clientSecret: 'synthetic', baseUrl: 'https://api.turn14.com',
    httpRuntime: { requestLane: lane, timeoutMs: 10, retries: 0, fetcher: async (url, options) => {
      assert.equal(options.signal.aborted, false, 'request timer starts only after admission');
      reads++;
      return url.endsWith('/token') ? Response.json({ access_token: 'synthetic', expires_in: 3600 }) : Response.json({ data: [] });
    } } });
  await client.get('/v1/brands');
  assert.equal(reads, 2);
});

test('unauthenticated supplier documentation probes also claim the shared lane without redirects', async () => {
  for (const script of ['DiscoverTurn14.mjs', 'DiscoverContracts.mjs']) {
    const source = await readFile(new URL('../scripts/' + script, import.meta.url), 'utf8');
    assert.match(source, /do \{ await supplierRequestLane\.wait\(\); \} while \(!supplierRequestLane\.tryStart\(\)\);\s*const response = await fetch/u);
    assert.match(source, /redirect: "manual"/u);
  }
});
test('multiple clients share the lane for token, retry, and GET attempts', async () => {
  const f = fixture(), starts = []; let reads = 0;
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error', 'redirects must not create hidden unpaced requests');
    starts.push({ at: f.time, token: url.endsWith('/token') });
    if (url.endsWith('/token')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
    return ++reads === 1 ? new Response(null, { status: 500 }) : Response.json({ data: [] });
  };
  const options = { clientId: 'synthetic', clientSecret: 'synthetic', baseUrl: 'https://api.turn14.com',
    httpRuntime: { fetcher, requestLane: f.lane, retries: 1, retryBaseMs: 0 } };
  const clients = [new Turn14Client(options), new Turn14Client(options)];
  await Promise.all(clients.map(client => client.get('/v1/brands')));
  assert.equal(starts.length, 5);
  assert.equal(starts.filter(start => start.token).length, 2);
  assert.equal(starts[0].at, 1500);
  assert.ok(starts.every((start, i) => i === 0 || start.at - starts[i - 1].at >= 1500));
});

