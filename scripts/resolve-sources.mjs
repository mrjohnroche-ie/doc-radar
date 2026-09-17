#!/usr/bin/env node
/**
 * Turn the names in data/sources.json into TMDB ids, once, and write them to
 * data/sources.resolved.json.
 *
 *   node scripts/resolve-sources.mjs
 *
 * This is deliberately a separate step from the weekly fetch. Name lookups are
 * the one genuinely ambiguous part of the whole system - TMDB has four companies
 * called "Neon" - so the ids get resolved under supervision, printed for a human
 * to check, and then committed. The fetch job never guesses.
 *
 * Re-run it when you add a source, or when a source's numbers look wrong.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, getAllPages, assertCredential } from './tmdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Companies are the ambiguous case. TMDB's search ranks by its own relevance,
 * which for "Neon" puts a defunct Korean post house above the distributor. So:
 * shortlist the name matches, then ask which of them has actually released the
 * most films. Catalogue size is a blunt instrument but it is never wrong about
 * which "Neon" is the one releasing documentaries.
 */
async function resolveCompany(query) {
  const results = await getAllPages('/search/company', { query }, { maxPages: 2 });
  if (!results.length) return { error: `no TMDB company named "${query}"` };

  const target = norm(query);
  const exact = results.filter((c) => norm(c.name) === target);
  const shortlist = (exact.length ? exact : results).slice(0, 5);

  if (shortlist.length === 1) {
    const only = shortlist[0];
    return { id: only.id, matchedName: only.name, confidence: exact.length ? 'exact' : 'best-guess' };
  }

  const scored = await Promise.all(
    shortlist.map(async (c) => {
      const page = await get('/discover/movie', { with_companies: c.id, page: 1 });
      return { company: c, films: page?.total_results ?? 0 };
    })
  );
  scored.sort((a, b) => b.films - a.films);
  const winner = scored[0];

  return {
    id: winner.company.id,
    matchedName: winner.company.name,
    confidence: exact.length ? 'exact' : 'best-guess',
    catalogue: winner.films,
    alternatives: scored.slice(1).map((s) => `${s.company.name} (#${s.company.id}, ${s.films} films)`)
  };
}

/**
 * Watch providers come from a flat list per region rather than a search endpoint,
 * so pull the list and match on name. Provider ids are global even though the
 * list is regional - we read the Irish list because that is the region the
 * calendar is built around, and fall back outwards.
 */
let providerCache = null;
async function providerList() {
  if (providerCache) return providerCache;
  const seen = new Map();
  for (const region of ['IE', 'GB', 'US']) {
    for (const kind of ['movie', 'tv']) {
      const page = await get(`/watch/providers/${kind}`, { watch_region: region });
      for (const p of page?.results || []) {
        if (!seen.has(p.provider_id)) seen.set(p.provider_id, p);
      }
    }
  }
  providerCache = [...seen.values()];
  return providerCache;
}

async function resolveProvider(query) {
  const all = await providerList();
  const target = norm(query);
  const hit =
    all.find((p) => norm(p.provider_name) === target) ||
    all.find((p) => norm(p.provider_name).startsWith(target)) ||
    all.find((p) => norm(p.provider_name).includes(target));

  if (!hit) return { error: `no TMDB watch provider named "${query}"` };
  return {
    id: hit.provider_id,
    matchedName: hit.provider_name,
    confidence: norm(hit.provider_name) === target ? 'exact' : 'best-guess'
  };
}

/**
 * A strand is a documentary series whose episodes are individual films -
 * Storyville, POV, 30 for 30. TMDB models these as ordinary TV shows, so we
 * resolve the show and record how many seasons it has; the fetcher only reads
 * the last couple.
 */
async function resolveStrand(query) {
  const page = await get('/search/tv', { query });
  const results = page?.results || [];
  if (!results.length) return { error: `no TMDB series named "${query}"` };

  const target = norm(query);
  const pick = results.find((s) => norm(s.name) === target) || results[0];
  const detail = await get(`/tv/${pick.id}`);

  return {
    id: pick.id,
    matchedName: pick.name,
    confidence: norm(pick.name) === target ? 'exact' : 'best-guess',
    seasons: detail?.number_of_seasons ?? 1,
    lastAirDate: detail?.last_air_date || null
  };
}

const resolvers = { company: resolveCompany, provider: resolveProvider, strand: resolveStrand };

async function main() {
  assertCredential();

  const { sources } = JSON.parse(await readFile(path.join(ROOT, 'data/sources.json'), 'utf8'));
  const resolved = {};
  const problems = [];

  for (const source of sources) {
    const specs = [];
    for (const spec of source.tmdb || []) {
      const resolver = resolvers[spec.type];
      if (!resolver) {
        problems.push(`${source.id}: unknown spec type "${spec.type}"`);
        continue;
      }

      const outcome = await resolver(spec.query);
      if (outcome.error) {
        problems.push(`${source.id}: ${outcome.error}`);
        /* Keep the unresolved spec in the file so the fetcher can report the
           source as uncovered rather than quietly acting as if it had no slate. */
        specs.push({ ...spec, id: null, error: outcome.error });
        continue;
      }

      specs.push({ ...spec, ...outcome });

      const flag = outcome.confidence === 'exact' ? ' ' : '?';
      const extra = outcome.alternatives?.length ? `  (also matched: ${outcome.alternatives.join('; ')})` : '';
      console.log(`${flag} ${source.name.padEnd(38)} ${spec.type.padEnd(9)} ${String(outcome.id).padEnd(8)} ${outcome.matchedName}${extra}`);
    }
    resolved[source.id] = { name: source.name, tmdb: specs };
  }

  await writeFile(
    path.join(ROOT, 'data/sources.resolved.json'),
    JSON.stringify({ resolvedAt: new Date().toISOString(), sources: resolved }, null, 2) + '\n'
  );

  console.log(`\nWrote data/sources.resolved.json`);
  if (problems.length) {
    console.log(`\n${problems.length} unresolved:`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log('\nThese sources will show as "not covered by TMDB" on the site.');
    console.log('Add them by hand in data/manual.json instead.');
  }
  console.log('\nLines marked ? were a best guess rather than an exact name match - worth an eye.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
