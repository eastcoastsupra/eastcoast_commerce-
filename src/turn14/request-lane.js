// Owner-configured ceiling across the two managed repositories; not a shared counter.
export const SUPPLIER_REQUEST_POLICY = Object.freeze({
  accountHourlyCeiling: 4999,
  managedLanes: 2,
  minRequestIntervalMs: 1500,
  inclusiveHourlyStartsPerLane: 2401,
  inclusiveHourlyStartsAcrossManagedLanes: 4802
});

/** One process-wide lane. Workflow concurrency serializes processes in each repository.
 * Initial delay also spaces sequential process/job restarts. Use a monotonic clock.
 */
export function createSupplierRequestLane({
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  if (typeof now !== 'function' || typeof sleep !== 'function') throw new Error('Invalid supplier request lane runtime.');
  let nextAt = null, lastClock = null;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || lastClock !== null && value < lastClock) throw new Error('Invalid supplier request lane clock.');
    lastClock = value;
    return value;
  };
  const initialize = () => {
    const at = clock();
    if (nextAt === null) nextAt = at + SUPPLIER_REQUEST_POLICY.minRequestIntervalMs;
    return at;
  };
  return Object.freeze({
    async wait() {
      let at = initialize();
      while (at < nextAt) { await sleep(nextAt - at); at = clock(); }
    },
    // Call immediately before the physical fetch, with no intervening await.
    // Waiting does not reserve a slot: concurrent callers must recheck here.
    tryStart() {
      const at = initialize();
      if (at < nextAt) return false;
      nextAt = at + SUPPLIER_REQUEST_POLICY.minRequestIntervalMs;
      return true;
    }
  });
}

export const supplierRequestLane = createSupplierRequestLane();

