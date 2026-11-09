// Cold-run scheduler: every measured run, and every retry of it, gets its own browser process with a fresh
// temporary profile, so no HTTP/code cache, cookies, storage, service workers, sockets or in-process DNS
// cache carry over. There are no warm-up runs; run indexes start at 1 and every run is counted.
// `from` lets one machine of a paired matrix measure only its own run index (e.g. from=2, runs=2 -> before2, after2).

export const coldRunOrder = (names, index, baselineFirst = false) => (
  names.length === 2 && index % 2 === 0 && !baselineFirst ? [...names].reverse() : [...names]
);

export async function measureCold({ names, runs, from = 1, attempts = 3, baselineFirst = false, launch, measure, onResult, onRetry }) {
  if (!Number.isInteger(from) || from < 1 || from > runs) throw new Error(`invalid first run index ${from} (runs ${runs})`);
  const results = Object.fromEntries(names.map((n) => [n, []]));
  for (let i = from; i <= runs; i += 1) {
    for (const name of coldRunOrder(names, i, baselineFirst)) {
      let result;
      for (let attempt = 1; ; attempt += 1) {
        const browser = await launch();
        let error;
        try {
          result = await measure(browser, name, i, attempt);
        } catch (e) {
          error = e;
        }
        // A browser that did not close cleanly may still hold state or a process: stop instead of carrying on.
        try {
          await browser.close();
        } catch (e) {
          throw new Error(`${name} run ${i} attempt ${attempt}: closing the browser failed: ${e.message}`, { cause: error ?? e });
        }
        if (!error) break;
        if (attempt >= attempts || error.fatal) throw error;
        onRetry?.(name, i, attempt, error);
      }
      results[name].push(result);
      onResult?.(name, i, result);
    }
  }
  return results;
}

// Earlier perf-ab versions saved one uncounted warm-up load per variant as before0.json / after0.json.
export const isLegacyWarmup = (file) => /(?:^|[\\/])(?:before|after)0\.json$/.test(file);
