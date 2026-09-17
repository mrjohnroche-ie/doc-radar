#!/usr/bin/env node
/**
 * Writes a plausible data/releases.json without touching TMDB, so the site can
 * be looked at and worked on before a key exists.
 *
 *   node scripts/demo-data.mjs && node build.mjs
 *
 * Everything it writes is marked `demo: true` and the page says so in a banner.
 * The first real `node scripts/fetch.mjs` overwrites the lot.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { sources } = JSON.parse(await readFile(path.join(ROOT, 'data/sources.json'), 'utf8'));

const iso = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 0));

const TITLES = [
  ['The Last Lighthouse Keeper', 'Aoife Brennan', 'Forty years alone on a rock in the Atlantic, and the month the light finally goes automatic.'],
  ['Cobalt', 'Jean-Luc Mbeki', 'The supply chain behind every battery on earth, traced backwards from a Dublin car park to a hillside in Katanga.'],
  ['Notes on a Vanishing Language', 'Sile Ni Chonaill', 'Three of the last eleven fluent speakers agree to be recorded. Two change their minds.'],
  ['Everything We Threw Away', 'Marcus Vale', 'A landfill archaeologist reads the twentieth century out of a hundred metres of compacted rubbish.'],
  ['The Understudy', 'Petra Lang', 'She covered the role for nineteen years and went on twice. This is about the other nights.'],
  ['Salt Road', 'Ibrahim Toure', 'A caravan crossing that has run for eight hundred years makes what may be its final journey.'],
  ['Quiet Car', 'Danny Okonjo', 'Filmed entirely in the silent carriage of the 06:12, over four years of commuters.'],
  ['The Forger Who Confessed', 'Elke Brandt', 'He fooled six museums, then spent thirty years trying to prove it, and nobody wanted to hear.'],
  ['After the Flood Came the Map', 'Rosa Iglesias', 'A village redraws its own boundaries after the water refuses to leave.'],
  ['Hold Music', 'Tom Devereux', 'The composers who write the loops you hear on hold, and what they think about all day.'],
  ['Weight Class', 'Nadia Haddad', 'Three fighters, one scale, and the eleven hours between the weigh-in and the bell.'],
  ['The Seed Vault Opens', 'Kristin Vang', 'Svalbard makes its first significant withdrawal, and the reasons are not the ones anyone planned for.']
];

const pickSources = (i) => {
  const pool = sources.filter((s) => s.kind !== 'sales');
  const a = pool[(i * 5) % pool.length];
  const b = pool[(i * 7 + 3) % pool.length];
  return i % 4 === 0 ? [a.id, b.id] : i % 5 === 0 ? [] : [a.id];
};

const span = to - from;
const releases = TITLES.map((t, i) => {
  const date = iso(new Date(from.getTime() + Math.floor((span * ((i * 37) % 100)) / 100)));
  const src = pickSources(i);
  return {
    id: `demo-${i}`,
    kind: i % 6 === 5 ? 'series' : 'film',
    title: t[0],
    year: Number(date.slice(0, 4)),
    overview: t[2],
    poster: null,
    runtime: 84 + ((i * 13) % 40),
    director: t[1],
    date,
    dateRegion: ['IE', 'GB', 'US', null][i % 4],
    dateType: ['theatrical', 'limited', 'digital', 'tv'][i % 4],
    otherDates: i % 3 === 0 ? [{ region: 'US', date, type: 'theatrical' }] : [],
    providers: i % 3 === 1 ? [{ name: 'MUBI', logo: null }] : [],
    tmdbUrl: null,
    imdbUrl: null,
    homepage: null,
    sources: src,
    unattributed: src.length === 0,
    popularity: 100 - i,
    demo: true
  };
}).sort((a, b) => a.date.localeCompare(b.date));

const health = {};
for (const s of sources) {
  health[s.id] = {
    status: 'ok',
    covered: true,
    notes: [],
    count: releases.filter((r) => r.sources.includes(s.id)).length
  };
}

await writeFile(
  path.join(ROOT, 'data/releases.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      demo: true,
      window: { from: iso(from), to: iso(to) },
      months: Array.from({ length: 4 }, (_, i) =>
        iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1))).slice(0, 7)
      ),
      sources: sources.map((s) => ({ ...s, tmdb: undefined, health: health[s.id] })),
      releases
    },
    null,
    2
  ) + '\n'
);

console.log(`Wrote demo data/releases.json - ${releases.length} invented titles. Run: node build.mjs`);
