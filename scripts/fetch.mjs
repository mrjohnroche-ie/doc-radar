#!/usr/bin/env node
/**
 * The weekly job. Reads data/sources.resolved.json, asks TMDB what is coming
 * out, merges anything hand-added in data/manual.json, and writes the single
 * file the site is built from: data/releases.json.
 *
 *   node scripts/fetch.mjs
 *
 * How it works, and why:
 *
 * 1. COLLECT. Three kinds of query run in parallel.
 *    - Each source's own companies and streaming services.
 *    - Each documentary strand (Storyville, POV, 30 for 30), whose episodes are
 *      individual films rather than instalments of one programme.
 *    - A wide net: every documentary with an Irish or British release date in the
 *      window, regardless of who is behind it. This is the safety net. TMDB's
 *      company data on unreleased titles is patchy, so a Dogwoof release that
 *      nobody has tagged yet still gets caught here - it just arrives unlabelled
 *      instead of missing.
 *
 * 2. ENRICH. One detail call per title, which brings back the full per-country
 *    release schedule, the streaming availability, and the director.
 *
 * 3. ATTRIBUTE. Work out who is behind each title from that enriched data rather
 *    than trusting which query found it. A film can come from three queries at
 *    once and it should end up with three badges, not three cards.
 *
 * Nothing here throws on a bad source. A source that fails is recorded as failed
 * and the site says so, because a calendar that silently drops a distributor is
 * worse than one that admits it lost sight of them.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, getAllPages, posterUrl, assertCredential } from './tmdb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The calendar proper: this month plus the next three. Anything further out is
   collected too but lives in its own section - a date eleven months away is an
   intention, not a plan. */
const CALENDAR_MONTHS = 4;
const HORIZON_MONTHS = 18;

/* UK and Ireland first, as asked. US is kept as a fallback date and shown as a
   secondary line when it differs, so a US-only release still appears rather than
   vanishing for want of a local date. */
const REGIONS = ['IE', 'GB', 'US'];
const WIDE_NET_REGIONS = ['IE', 'GB'];

const DOCUMENTARY_GENRE = 99;

/* TMDB's release types, in the order we would rather quote them. A cinema date
   is the real answer to "when can I see this"; a premiere is a festival screening
   most people cannot attend, so it ranks last. */
const RELEASE_TYPES = {
  3: 'theatrical',
  2: 'limited',
  4: 'digital',
  6: 'tv',
  1: 'premiere',
  5: 'physical'
};
const TYPE_RANK = { 3: 0, 2: 1, 4: 2, 6: 3, 1: 4, 5: 5 };

const iso = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => String(d).slice(0, 7);

function window_(months) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, 0));
  return { from: iso(from), to: iso(to) };
}

// ---------------------------------------------------------------- collection

/**
 * Every title we have seen, keyed by a stable id. Queries overlap heavily by
 * design, so collection is a merge rather than a list append: the first query to
 * find a title creates the entry and later ones only add attribution hints.
 */
const candidates = new Map();

function note(key, patch) {
  const existing = candidates.get(key);
  if (!existing) {
    candidates.set(key, { foundBy: new Set(), ...patch });
    return candidates.get(key);
  }
  if (patch.foundBy) for (const f of patch.foundBy) existing.foundBy.add(f);
  return existing;
}

async function collectCompany(sourceId, companyId, docsOnly, win, horizon) {
  const base = {
    with_companies: companyId,
    sort_by: 'primary_release_date.asc',
    include_adult: false,
    /* Genre data on unreleased titles is unreliable. For outfits that release
       nothing but non-fiction, filtering by it loses more than it saves. */
    with_genres: docsOnly ? undefined : DOCUMENTARY_GENRE
  };

  const queries = [];

  /* Per-region, so the dates we get back are the dates that apply here. */
  for (const region of REGIONS) {
    queries.push(
      getAllPages('/discover/movie', {
        ...base,
        region,
        with_release_type: '2|3|4|6',
        'release_date.gte': win.from,
        'release_date.lte': win.to
      })
    );
  }

  /* And once without a region, which catches titles that have a date on the
     record but no country breakdown yet - common months ahead of release. */
  queries.push(
    getAllPages('/discover/movie', {
      ...base,
      'primary_release_date.gte': win.from,
      'primary_release_date.lte': horizon.to
    })
  );

  const pages = await Promise.all(queries);
  for (const movie of pages.flat()) {
    note(`movie-${movie.id}`, { type: 'movie', tmdbId: movie.id, foundBy: [sourceId] });
  }
}

async function collectProvider(sourceId, providerId, win) {
  const queries = [];
  for (const region of ['IE', 'GB']) {
    queries.push(
      getAllPages('/discover/movie', {
        with_watch_providers: providerId,
        watch_region: region,
        with_genres: DOCUMENTARY_GENRE,
        with_release_type: '4|6',
        'release_date.gte': win.from,
        'release_date.lte': win.to,
        sort_by: 'primary_release_date.asc'
      })
    );
    queries.push(
      getAllPages('/discover/tv', {
        with_watch_providers: providerId,
        watch_region: region,
        with_genres: DOCUMENTARY_GENRE,
        'first_air_date.gte': win.from,
        'first_air_date.lte': win.to,
        sort_by: 'first_air_date.asc'
      })
    );
  }

  const [movies1, tv1, movies2, tv2] = await Promise.all(queries);
  for (const m of [...movies1, ...movies2]) {
    note(`movie-${m.id}`, { type: 'movie', tmdbId: m.id, foundBy: [sourceId] });
  }
  for (const t of [...tv1, ...tv2]) {
    note(`tv-${t.id}`, { type: 'tv', tmdbId: t.id, foundBy: [sourceId] });
  }
}

/**
 * A strand's episodes are the films. Read the last few seasons rather than the
 * whole run: Storyville has been going since 1997 and we want next month.
 */
async function collectStrand(sourceId, showId, seasonCount, win) {
  const detail = await get(`/tv/${showId}`);
  if (!detail) return;

  const seasons = (detail.seasons || [])
    .filter((s) => s.season_number > 0)
    .sort((a, b) => b.season_number - a.season_number)
    .slice(0, 3);

  const fetched = await Promise.all(
    seasons.map((s) => get(`/tv/${showId}/season/${s.season_number}`))
  );

  for (const season of fetched) {
    for (const ep of season?.episodes || []) {
      if (!ep.air_date || ep.air_date < win.from || ep.air_date > win.to) continue;
      candidates.set(`ep-${showId}-${ep.id}`, {
        type: 'episode',
        foundBy: new Set([sourceId]),
        ready: {
          id: `ep-${showId}-${ep.id}`,
          kind: 'strand',
          title: ep.name,
          strand: detail.name,
          overview: ep.overview || detail.overview || '',
          poster: posterUrl(ep.still_path || detail.poster_path, 'w342'),
          date: ep.air_date,
          dateRegion: sourceId === 'bbc-storyville' ? 'GB' : 'US',
          dateType: 'tv',
          runtime: ep.runtime || null,
          director: (ep.crew || []).find((c) => c.job === 'Director')?.name || null,
          tmdbUrl: `https://www.themoviedb.org/tv/${showId}/season/${season.season_number}/episode/${ep.episode_number}`,
          sources: [sourceId],
          providers: []
        }
      });
    }
  }
}

async function collectWideNet(win) {
  const queries = [];
  for (const region of WIDE_NET_REGIONS) {
    queries.push(
      getAllPages(
        '/discover/movie',
        {
          with_genres: DOCUMENTARY_GENRE,
          region,
          with_release_type: '2|3|4',
          'release_date.gte': win.from,
          'release_date.lte': win.to,
          sort_by: 'primary_release_date.asc',
          include_adult: false
        },
        { maxPages: 15 }
      )
    );
  }
  queries.push(
    getAllPages(
      '/discover/tv',
      {
        with_genres: DOCUMENTARY_GENRE,
        'first_air_date.gte': win.from,
        'first_air_date.lte': win.to,
        sort_by: 'popularity.desc',
        include_adult: false
      },
      { maxPages: 5 }
    )
  );

  const pages = await Promise.all(queries);
  const [movieSets, tvSet] = [pages.slice(0, -1), pages[pages.length - 1]];

  for (const movie of movieSets.flat()) {
    note(`movie-${movie.id}`, { type: 'movie', tmdbId: movie.id, foundBy: ['_wide'] });
  }
  for (const show of tvSet) {
    note(`tv-${show.id}`, { type: 'tv', tmdbId: show.id, foundBy: ['_wide'] });
  }
}

// ------------------------------------------------------------------ enrichment

/**
 * Pick the date to lead with. Ireland first, then the UK, then the US, and
 * within a country a cinema date beats a streaming date beats a festival
 * premiere. Everything else is kept so the card can say "US 12 Oct" underneath.
 */
function chooseDate(releaseDates, win) {
  const perRegion = [];

  for (const entry of releaseDates?.results || []) {
    const region = entry.iso_3166_1;
    if (!REGIONS.includes(region)) continue;

    const dated = (entry.release_dates || [])
      .filter((r) => r.release_date)
      .map((r) => ({
        region,
        date: r.release_date.slice(0, 10),
        type: RELEASE_TYPES[r.type] || 'unknown',
        rank: TYPE_RANK[r.type] ?? 9,
        note: r.note || null
      }))
      .filter((r) => r.date >= win.from && r.date <= win.to)
      .sort((a, b) => a.rank - b.rank || a.date.localeCompare(b.date));

    if (dated.length) perRegion.push(dated[0]);
  }

  perRegion.sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region));
  return { lead: perRegion[0] || null, all: perRegion };
}

async function enrichMovie(tmdbId, win) {
  const m = await get(`/movie/${tmdbId}`, {
    append_to_response: 'release_dates,watch/providers,credits,external_ids'
  });
  if (!m) return null;

  const { lead, all } = chooseDate(m.release_dates, win);

  /* No local date, but TMDB has a headline release date in the window: use it
     and be honest that we do not know which country it refers to. */
  const fallback =
    !lead && m.release_date && m.release_date >= win.from && m.release_date <= win.to
      ? { region: null, date: m.release_date, type: 'unknown' }
      : null;

  const chosen = lead || fallback;
  if (!chosen) return null;

  const providers = m['watch/providers']?.results?.IE || m['watch/providers']?.results?.GB || {};
  const flat = [...(providers.flatrate || []), ...(providers.rent || [])];

  return {
    id: `movie-${m.id}`,
    kind: 'film',
    title: m.title,
    originalTitle: m.original_title !== m.title ? m.original_title : null,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
    overview: m.overview || '',
    poster: posterUrl(m.poster_path),
    runtime: m.runtime || null,
    director: (m.credits?.crew || []).find((c) => c.job === 'Director')?.name || null,
    date: chosen.date,
    dateRegion: chosen.region,
    dateType: chosen.type,
    otherDates: all.filter((d) => d.date !== chosen.date || d.region !== chosen.region),
    companies: (m.production_companies || []).map((c) => c.id),
    providerIds: flat.map((p) => p.provider_id),
    providers: flat.slice(0, 4).map((p) => ({ name: p.provider_name, logo: posterUrl(p.logo_path, 'w92') })),
    genres: (m.genres || []).map((g) => g.id),
    tmdbUrl: `https://www.themoviedb.org/movie/${m.id}`,
    imdbUrl: m.external_ids?.imdb_id ? `https://www.imdb.com/title/${m.external_ids.imdb_id}/` : null,
    homepage: m.homepage || null,
    popularity: m.popularity || 0
  };
}

async function enrichTv(tmdbId, win) {
  const t = await get(`/tv/${tmdbId}`, { append_to_response: 'watch/providers,external_ids,credits' });
  if (!t) return null;
  if (!t.first_air_date || t.first_air_date < win.from || t.first_air_date > win.to) return null;

  const providers = t['watch/providers']?.results?.IE || t['watch/providers']?.results?.GB || {};
  const flat = [...(providers.flatrate || []), ...(providers.rent || [])];

  return {
    id: `tv-${t.id}`,
    kind: 'series',
    title: t.name,
    originalTitle: t.original_name !== t.name ? t.original_name : null,
    year: Number(t.first_air_date.slice(0, 4)),
    overview: t.overview || '',
    poster: posterUrl(t.poster_path),
    runtime: t.episode_run_time?.[0] || null,
    episodes: t.number_of_episodes || null,
    director: (t.created_by || []).map((c) => c.name).join(', ') || null,
    date: t.first_air_date,
    dateRegion: null,
    dateType: 'tv',
    otherDates: [],
    companies: (t.production_companies || []).map((c) => c.id),
    networks: (t.networks || []).map((n) => n.id),
    providerIds: flat.map((p) => p.provider_id),
    providers: flat.slice(0, 4).map((p) => ({ name: p.provider_name, logo: posterUrl(p.logo_path, 'w92') })),
    genres: (t.genres || []).map((g) => g.id),
    tmdbUrl: `https://www.themoviedb.org/tv/${t.id}`,
    imdbUrl: t.external_ids?.imdb_id ? `https://www.imdb.com/title/${t.external_ids.imdb_id}/` : null,
    homepage: t.homepage || null,
    popularity: t.popularity || 0
  };
}

// ------------------------------------------------------------------------ main

async function main() {
  assertCredential();

  const { sources } = JSON.parse(await readFile(path.join(ROOT, 'data/sources.json'), 'utf8'));
  const resolvedPath = path.join(ROOT, 'data/sources.resolved.json');
  if (!existsSync(resolvedPath)) {
    throw new Error('data/sources.resolved.json is missing. Run: node scripts/resolve-sources.mjs');
  }
  const resolved = JSON.parse(await readFile(resolvedPath, 'utf8')).sources;

  const win = window_(CALENDAR_MONTHS);
  const horizon = window_(HORIZON_MONTHS);
  console.log(`Window ${win.from} to ${win.to} (horizon to ${horizon.to})\n`);

  /* Lookup tables for attribution, built from the resolved ids. */
  const companyToSource = new Map();
  const providerToSource = new Map();
  const health = {};

  const jobs = [];
  for (const source of sources) {
    const specs = resolved[source.id]?.tmdb || [];
    health[source.id] = { status: 'ok', covered: specs.some((s) => s.id), notes: [] };

    for (const spec of specs) {
      if (!spec.id) {
        health[source.id].notes.push(spec.error || `unresolved ${spec.type}`);
        continue;
      }
      if (spec.type === 'company') {
        companyToSource.set(spec.id, source.id);
        jobs.push([source.id, collectCompany(source.id, spec.id, source.docsOnly, win, horizon)]);
      } else if (spec.type === 'provider') {
        providerToSource.set(spec.id, source.id);
        jobs.push([source.id, collectProvider(source.id, spec.id, win)]);
      } else if (spec.type === 'strand') {
        jobs.push([source.id, collectStrand(source.id, spec.id, spec.seasons, win)]);
      }
    }
  }
  jobs.push(['_wide', collectWideNet(win)]);

  const outcomes = await Promise.allSettled(jobs.map(([, p]) => p));
  outcomes.forEach((o, i) => {
    if (o.status !== 'rejected') return;
    const id = jobs[i][0];
    if (health[id]) {
      health[id].status = 'failed';
      health[id].notes.push(String(o.reason?.message || o.reason));
    }
    console.error(`  ! ${id}: ${o.reason?.message || o.reason}`);
  });

  console.log(`Collected ${candidates.size} candidate titles. Enriching...`);

  /* Episodes arrive fully formed; everything else needs a detail call. */
  const releases = [];
  const toEnrich = [];
  for (const [key, c] of candidates) {
    if (c.ready) releases.push({ ...c.ready, foundBy: [...c.foundBy] });
    else toEnrich.push([key, c]);
  }

  const enriched = await Promise.allSettled(
    toEnrich.map(([, c]) => (c.type === 'movie' ? enrichMovie(c.tmdbId, win) : enrichTv(c.tmdbId, win)))
  );

  enriched.forEach((o, i) => {
    if (o.status !== 'fulfilled' || !o.value) return;
    const [, c] = toEnrich[i];
    const record = o.value;

    /* Attribution from the enriched record, not from which query found it. */
    const attributed = new Set();
    for (const companyId of record.companies || []) {
      const s = companyToSource.get(companyId);
      if (s) attributed.add(s);
    }
    for (const providerId of record.providerIds || []) {
      const s = providerToSource.get(providerId);
      if (s) attributed.add(s);
    }
    /* A targeted query is itself evidence: if we asked Dogwoof's company id for
       its slate and this came back, it is a Dogwoof title even when the company
       credit has not been filled in on the record yet. */
    for (const f of c.foundBy) if (f !== '_wide') attributed.add(f);

    record.sources = [...attributed];
    record.unattributed = attributed.size === 0;
    delete record.companies;
    delete record.providerIds;
    delete record.networks;
    releases.push(record);
  });

  /* Anything hand-added wins: it is there precisely because the automation could
     not see it, so it is never overwritten by what the automation did see. */
  const manualPath = path.join(ROOT, 'data/manual.json');
  const manual = existsSync(manualPath) ? JSON.parse(await readFile(manualPath, 'utf8')).releases || [] : [];
  const manualTitles = new Set(manual.map((m) => `${m.title}`.toLowerCase()));
  const merged = releases.filter((r) => !manualTitles.has(r.title.toLowerCase()));
  for (const m of manual) {
    merged.push({ ...m, id: m.id || `manual-${m.title.toLowerCase().replace(/\W+/g, '-')}`, manual: true });
  }

  merged.sort((a, b) => a.date.localeCompare(b.date) || b.popularity - a.popularity);

  /* Count what each source actually yielded, so the site can say "Dogwoof: 3
     titles" or "Cinephil: nothing dated" rather than leaving you to wonder
     whether it is quiet or broken. */
  for (const id of Object.keys(health)) {
    health[id].count = merged.filter((r) => (r.sources || []).includes(id)).length;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    window: win,
    months: Array.from({ length: CALENDAR_MONTHS }, (_, i) => {
      const d = new Date();
      return monthKey(iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1))));
    }),
    sources: sources.map((s) => ({ ...s, tmdb: undefined, health: health[s.id] })),
    releases: merged
  };

  await writeFile(path.join(ROOT, 'data/releases.json'), JSON.stringify(payload, null, 2) + '\n');

  const dated = merged.filter((r) => r.date <= win.to).length;
  console.log(`\nWrote data/releases.json - ${merged.length} titles, ${dated} inside the calendar window.`);
  const quiet = Object.entries(health).filter(([, h]) => h.count === 0).map(([id]) => id);
  if (quiet.length) console.log(`Nothing dated from: ${quiet.join(', ')}`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
