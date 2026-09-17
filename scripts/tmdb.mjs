/**
 * A small TMDB client. No dependencies - Node 18+ has fetch built in.
 *
 * Auth: TMDB hands out two different credentials and people grab whichever one
 * they see first, so accept both. The v4 token is a long JWT with dots in it and
 * goes in the Authorization header; the v3 key is 32 hex characters and goes in
 * the query string. Guessing wrong gives a 401 that looks like a bad key, which
 * is a miserable thing to debug, so we sniff the shape instead of asking.
 */

const BASE = 'https://api.themoviedb.org/3';

const credential = (process.env.TMDB_API_KEY || process.env.TMDB_TOKEN || '').trim();
const isV4Token = credential.includes('.');

export function assertCredential() {
  if (credential) return;
  throw new Error(
    'No TMDB credential. Set TMDB_API_KEY (or TMDB_TOKEN) in the environment.\n' +
      '  Locally:  export TMDB_API_KEY="your-key"\n' +
      '  In CI:    add it as the repository secret TMDB_API_KEY'
  );
}

/* TMDB's published ceiling is about 50 requests a second. We stay well under it:
   the run is a few hundred calls and finishing two seconds sooner is worth
   nothing next to being rate limited half way through and writing partial data. */
const CONCURRENCY = 8;
let inFlight = 0;
const queue = [];

function slot() {
  if (inFlight < CONCURRENCY) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a TMDB endpoint. Returns parsed JSON.
 *
 * A 404 resolves to null rather than throwing: plenty of our lookups are
 * speculative ("does this strand exist as a TV series?") and a miss is an
 * answer, not a failure.
 */
export async function get(path, params = {}, { retries = 3 } = {}) {
  assertCredential();

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (!isV4Token) url.searchParams.set('api_key', credential);

  const headers = { accept: 'application/json' };
  if (isV4Token) headers.authorization = `Bearer ${credential}`;

  await slot();
  try {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (res.status === 404) return null;

      if (res.status === 429) {
        /* Honour the server's own backoff; it knows better than we do. */
        const wait = Number(res.headers.get('retry-after') || 1) * 1000 + 250;
        await sleep(wait);
        continue;
      }

      if (res.status === 401) {
        throw new Error(
          'TMDB rejected the credential (401). Check TMDB_API_KEY is the API Read Access Token ' +
            'or the v3 API Key from https://www.themoviedb.org/settings/api'
        );
      }

      if (!res.ok) {
        if (attempt >= retries) throw new Error(`TMDB ${res.status} on ${path}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }

      return res.json();
    }
  } finally {
    release();
  }
}

/**
 * Walk a paginated discover/search endpoint. TMDB caps out at 500 pages and
 * anything sane here is one or two, so `maxPages` is a guard against a query
 * accidentally matching the whole database rather than a real limit.
 */
export async function getAllPages(path, params = {}, { maxPages = 10 } = {}) {
  const first = await get(path, { ...params, page: 1 });
  if (!first || !Array.isArray(first.results)) return [];

  const results = [...first.results];
  const pages = Math.min(first.total_pages || 1, maxPages);
  if (pages < 2) return results;

  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => get(path, { ...params, page: i + 2 }))
  );
  for (const page of rest) {
    if (page && Array.isArray(page.results)) results.push(...page.results);
  }
  return results;
}

export const posterUrl = (p, size = 'w342') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);
