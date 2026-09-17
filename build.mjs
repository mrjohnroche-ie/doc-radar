#!/usr/bin/env node
/**
 * Doc Radar - static site builder.
 *
 *   node build.mjs
 *
 * Reads data/releases.json (written by scripts/fetch.mjs) and writes dist/:
 * one HTML page, a stylesheet, a script, a calendar feed and an RSS feed.
 * No framework, no bundler, no dependencies. Every path is relative, so the
 * built site works over http or straight off the file system.
 */

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const SITE = {
  title: 'Doc Radar',
  tagline: 'Every documentary worth knowing about, month by month.',
  description:
    'Upcoming documentary releases from the distributors, broadcasters, streamers and sales agents that matter. Updated weekly.',
  url: 'https://doc-radar-weld.vercel.app'
};

const data = JSON.parse(await readFile(path.join(ROOT, 'data/releases.json'), 'utf8'));

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
};

const dayLabel = (isoDate) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)}`;
};

const REGION_LABEL = { IE: 'Ireland', GB: 'UK', US: 'US' };
const KIND_LABEL = {
  theatrical: 'In cinemas',
  broadcast: 'On television',
  streaming: 'Streaming',
  sales: 'Sales slate'
};

const sourceById = new Map(data.sources.map((s) => [s.id, s]));

/* Everything beyond the calendar window is real but speculative, so it gets its
   own bucket rather than four more month headings nobody scrolls to. */
const inWindow = (r) => r.date >= data.window.from && r.date <= data.window.to;
const calendar = data.releases.filter(inWindow);
const horizon = data.releases.filter((r) => r.date > data.window.to);

const byMonth = new Map();
for (const r of calendar) {
  const key = r.date.slice(0, 7);
  if (!byMonth.has(key)) byMonth.set(key, []);
  byMonth.get(key).push(r);
}

// ------------------------------------------------------------------- markup

function card(r) {
  const sources = (r.sources || []).map((id) => sourceById.get(id)).filter(Boolean);
  const kinds = [...new Set(sources.map((s) => s.kind))];

  const badges = sources.length
    ? sources.map((s) => `<span class="badge badge--${s.kind}">${esc(s.name)}</span>`).join('')
    : '<span class="badge badge--loose">Unlisted distributor</span>';

  const meta = [
    r.director && `Directed by ${esc(r.director)}`,
    r.runtime && `${r.runtime} min`,
    r.episodes && `${r.episodes} episodes`,
    r.strand && esc(r.strand)
  ]
    .filter(Boolean)
    .join(' &middot; ');

  const other = (r.otherDates || [])
    .map((d) => `${REGION_LABEL[d.region] || d.region} ${dayLabel(d.date)}`)
    .join(', ');

  const links = [
    r.homepage && `<a href="${esc(r.homepage)}">Official site</a>`,
    r.tmdbUrl && `<a href="${esc(r.tmdbUrl)}">TMDB</a>`,
    r.imdbUrl && `<a href="${esc(r.imdbUrl)}">IMDb</a>`
  ]
    .filter(Boolean)
    .join('');

  const where = (r.providers || [])
    .map((p) => `<span class="where">${esc(p.name)}</span>`)
    .join('');

  const poster = r.poster
    ? `<img class="card__art" src="${esc(r.poster)}" alt="" loading="lazy" width="342" height="513">`
    : `<div class="card__art card__art--blank" aria-hidden="true">${esc(r.title.slice(0, 1))}</div>`;

  return `<article class="card" data-title="${esc(r.title.toLowerCase())}" data-sources="${esc((r.sources || []).join(' '))}" data-kinds="${esc(kinds.join(' '))}" data-month="${esc(r.date.slice(0, 7))}" data-loose="${r.unattributed ? '1' : '0'}">
  <div class="card__date">
    <span class="card__day">${dayLabel(r.date)}</span>
    ${r.dateRegion ? `<span class="card__region">${REGION_LABEL[r.dateRegion] || r.dateRegion}</span>` : '<span class="card__region card__region--vague">date TBC</span>'}
  </div>
  ${poster}
  <div class="card__body">
    <h3 class="card__title">${esc(r.title)}${r.year ? ` <span class="card__year">${r.year}</span>` : ''}</h3>
    ${meta ? `<p class="card__meta">${meta}</p>` : ''}
    <p class="card__badges">${badges}${r.manual ? '<span class="badge badge--manual">added by hand</span>' : ''}</p>
    ${r.overview ? `<p class="card__blurb">${esc(r.overview)}</p>` : ''}
    <p class="card__foot">
      <span class="card__type">${esc(r.dateType === 'unknown' ? 'release' : r.dateType)}</span>
      ${other ? `<span class="card__other">also ${other}</span>` : ''}
      ${where}
    </p>
    ${links ? `<p class="card__links">${links}</p>` : ''}
  </div>
</article>`;
}

const monthSections = data.months
  .map((key) => {
    const items = byMonth.get(key) || [];
    return `<section class="month" data-month="${key}" id="m-${key}">
  <h2 class="month__head"><span>${monthLabel(key)}</span> <span class="month__count">${items.length}</span></h2>
  <div class="grid">${items.map(card).join('\n')}</div>
  ${items.length ? '' : '<p class="month__empty">Nothing dated yet. The weekly run will fill this in as dates are announced.</p>'}
</section>`;
  })
  .join('\n');

const horizonSection = horizon.length
  ? `<section class="month month--horizon" data-month="horizon" id="m-horizon">
  <h2 class="month__head"><span>Further out</span> <span class="month__count">${horizon.length}</span></h2>
  <p class="month__note">Dated, but far enough away that the date will probably move.</p>
  <div class="grid">${horizon.map(card).join('\n')}</div>
</section>`
  : '';

const sourceRows = data.sources
  .map((s) => {
    const h = s.health || {};
    const state = h.status === 'failed' ? 'bad' : h.count > 0 ? 'good' : h.covered ? 'quiet' : 'bad';
    const said =
      h.status === 'failed'
        ? 'lookup failed'
        : h.count > 0
          ? `${h.count} title${h.count === 1 ? '' : 's'}`
          : h.covered
            ? 'nothing dated'
            : 'not on TMDB';
    return `<tr class="src src--${state}">
  <td class="src__name"><a href="${esc(s.slate || s.site)}">${esc(s.name)}</a></td>
  <td class="src__kind">${esc(KIND_LABEL[s.kind])}</td>
  <td class="src__where">${esc(s.country)}</td>
  <td class="src__count">${esc(said)}</td>
</tr>`;
  })
  .join('\n');

const filterChips = Object.entries(KIND_LABEL)
  .map(([k, label]) => `<button class="chip" data-kind="${k}" aria-pressed="false">${esc(label)}</button>`)
  .join('');

const monthTabs = [
  `<button class="tab" data-month="all" aria-pressed="true">Everything</button>`,
  ...data.months.map(
    (key, i) =>
      `<button class="tab" data-month="${key}" aria-pressed="false">${i === 0 ? 'This month' : i === 1 ? 'Next month' : monthLabel(key).split(' ')[0]}</button>`
  ),
  horizon.length ? `<button class="tab" data-month="horizon" aria-pressed="false">Further out</button>` : ''
]
  .filter(Boolean)
  .join('');

const updated = new Date(data.generatedAt);
const updatedLabel = `${updated.getUTCDate()} ${MONTH_NAMES[updated.getUTCMonth()]} ${updated.getUTCFullYear()}`;

const html = `<!doctype html>
<html lang="en-IE">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(SITE.title)} &middot; upcoming documentaries</title>
<meta name="description" content="${esc(SITE.description)}">
<meta property="og:title" content="${esc(SITE.title)}">
<meta property="og:description" content="${esc(SITE.description)}">
<link rel="alternate" type="application/rss+xml" title="${esc(SITE.title)}" href="feed.xml">
<link rel="stylesheet" href="styles.css">
</head>
<body>

${data.demo ? `<p class="demo-banner">Demo data. These twelve films are invented - the real run has not happened yet. Set <code>TMDB_API_KEY</code> and run <code>npm run update</code>.</p>` : ''}

<header class="top">
  <div class="top__inner">
    <h1 class="top__title">${esc(SITE.title)}</h1>
    <p class="top__tag">${esc(SITE.tagline)}</p>
    <p class="top__stat">
      <strong>${calendar.length}</strong> releases across <strong>${data.sources.length}</strong> sources
      &middot; updated ${esc(updatedLabel)}
    </p>
    <p class="top__feeds">
      <a class="feedlink" href="feed.ics">Subscribe in your calendar</a>
      <a class="feedlink feedlink--quiet" href="feed.xml">RSS</a>
    </p>
  </div>
</header>

<nav class="filters" aria-label="Filter releases">
  <div class="filters__inner">
    <div class="tabs" role="group" aria-label="Month">${monthTabs}</div>
    <div class="chips" role="group" aria-label="Kind">${filterChips}</div>
    <label class="search">
      <span class="visually-hidden">Search titles</span>
      <input type="search" id="q" placeholder="Search titles, directors, distributors" autocomplete="off">
    </label>
    <label class="toggle">
      <input type="checkbox" id="loose" checked>
      <span>Include titles from outside the list</span>
    </label>
  </div>
</nav>

<main id="main">
  <p class="noresults" id="noresults" hidden>Nothing matches that.</p>
${monthSections}
${horizonSection}
</main>

<section class="sources">
  <h2>Where this comes from</h2>
  <p class="sources__intro">
    Twenty-five distributors, broadcasters, streamers and sales agents, checked every week.
    A source showing <em>nothing dated</em> is quiet, not broken; one showing <em>not on TMDB</em>
    needs its releases added by hand.
  </p>
  <table class="sources__table">
    <thead><tr><th>Source</th><th>Kind</th><th>Based</th><th>This window</th></tr></thead>
    <tbody>${sourceRows}</tbody>
  </table>
</section>

<footer class="foot">
  <p>
    Built from <a href="https://www.themoviedb.org/">TMDB</a>, refreshed every Monday by a scheduled job.
    This product uses the TMDB API but is not endorsed or certified by TMDB.
  </p>
  <p class="foot__when">Last run ${esc(data.generatedAt)}</p>
</footer>

<script src="app.js"></script>
</body>
</html>
`;

// --------------------------------------------------------------------- feeds

/* iCalendar wants CRLF line endings and lines folded at 75 octets. Calendar
   clients are famously unforgiving about both. */
function icsFold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 73) {
    let cut = 73;
    while (Buffer.byteLength(rest.slice(0, cut)) > 73) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

const icsText = (s) =>
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

const stamp = new Date(data.generatedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

const events = data.releases.map((r) => {
  const start = r.date.replace(/-/g, '');
  const end = new Date(r.date + 'T00:00:00Z');
  end.setUTCDate(end.getUTCDate() + 1);
  const names = (r.sources || []).map((id) => sourceById.get(id)?.name).filter(Boolean).join(', ');
  const body = [
    r.director ? `Directed by ${r.director}` : null,
    names ? `From ${names}` : null,
    r.overview || null,
    r.tmdbUrl || null
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    'BEGIN:VEVENT',
    icsFold(`UID:${r.id}@doc-radar`),
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end.toISOString().slice(0, 10).replace(/-/g, '')}`,
    icsFold(`SUMMARY:${icsText(r.title)}${names ? icsText(` (${names})`) : ''}`),
    icsFold(`DESCRIPTION:${icsText(body)}`),
    r.tmdbUrl ? icsFold(`URL:${r.tmdbUrl}`) : null,
    'TRANSP:TRANSPARENT',
    'END:VEVENT'
  ]
    .filter(Boolean)
    .join('\r\n');
});

const ics = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Doc Radar//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  `X-WR-CALNAME:${icsText(SITE.title)}`,
  'X-WR-TIMEZONE:Europe/Dublin',
  'REFRESH-INTERVAL;VALUE=DURATION:P1D',
  'X-PUBLISHED-TTL:P1D',
  ...events,
  'END:VCALENDAR'
].join('\r\n') + '\r\n';

const rssItems = calendar
  .slice(0, 100)
  .map((r) => {
    const names = (r.sources || []).map((id) => sourceById.get(id)?.name).filter(Boolean).join(', ');
    return `    <item>
      <title>${esc(r.title)}${names ? esc(` (${names})`) : ''}</title>
      <link>${esc(r.tmdbUrl || r.homepage || SITE.url)}</link>
      <guid isPermaLink="false">${esc(r.id)}</guid>
      <pubDate>${new Date(r.date + 'T09:00:00Z').toUTCString()}</pubDate>
      <description>${esc([r.director && `Directed by ${r.director}.`, r.overview].filter(Boolean).join(' '))}</description>
    </item>`;
  })
  .join('\n');

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(SITE.title)}</title>
    <link>${esc(SITE.url)}</link>
    <description>${esc(SITE.description)}</description>
    <language>en-ie</language>
    <lastBuildDate>${new Date(data.generatedAt).toUTCString()}</lastBuildDate>
${rssItems}
  </channel>
</rss>
`;

// --------------------------------------------------------------------- write

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await writeFile(path.join(DIST, 'index.html'), html);
await writeFile(path.join(DIST, 'feed.ics'), ics);
await writeFile(path.join(DIST, 'feed.xml'), rss);
if (existsSync(path.join(ROOT, 'src'))) {
  await cp(path.join(ROOT, 'src'), DIST, { recursive: true });
}
await writeFile(path.join(DIST, '.nojekyll'), '');

console.log(`Built dist/ - ${calendar.length} in window, ${horizon.length} further out, ${data.releases.length} events in the calendar feed.`);
