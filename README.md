# Doc Radar

Every documentary worth knowing about, month by month, from twenty-five
distributors, broadcasters, streamers and sales agents. It refreshes itself
every Monday and needs no server.

Open the site, see what is out this month and next. Subscribe to the calendar
feed and new releases turn up in your diary on their own.

## Setting it up

You need a TMDB key. It is free, takes two minutes, and no card is involved.

1. Make an account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Go to [Settings → API](https://www.themoviedb.org/settings/api) and request a
   key. Choose "Developer", and for the usage question say it is a personal
   non-commercial release calendar.
3. Copy either credential it gives you. The short **API Key (v3 auth)** and the
   long **API Read Access Token** both work; the code sniffs which one you gave it.

Then put it in a `.env` at the repo root:

```bash
cp .env.example .env     # then paste the key in after the =
```

`.env` is gitignored and never leaves your machine. Every script reads it, so
there is nothing to export and nothing to remember.

```bash
node scripts/resolve-sources.mjs   # once: turns names into TMDB ids
node scripts/fetch.mjs             # asks TMDB what is coming out
node build.mjs                     # writes dist/
node serve.mjs                     # http://localhost:4190
```

Then commit and push. That push is the deploy.

And in the repo, so the weekly job can run: **Settings → Secrets and variables →
Actions → New repository secret**, named `TMDB_API_KEY`.

## Hosting

Vercel, connected to this repo. Import it at
[vercel.com/new](https://vercel.com/new) and take every default - `vercel.json`
already says to run `node build.mjs` and serve `dist/`. There is nothing to
configure and no environment variable to set on Vercel: the key is only ever
used by the GitHub job, never at build time.

Once connected, every push deploys.

Commit `data/sources.resolved.json` when you are happy with it. The weekly job
never re-resolves ids on its own.

### Looking at it before you have a key

```bash
node scripts/demo-data.mjs && node build.mjs
```

Twelve invented films, so you can see the layout. The page says so in a banner,
and the first real fetch wipes them.

## How it keeps itself up to date

`.github/workflows/update.yml` runs at 06:00 UTC every Monday. It fetches,
rebuilds, and commits. That commit is the whole deploy mechanism - Vercel is
watching the repo and republishes on its own, so the job never needs Vercel
credentials. You can also run it by hand from the Actions tab, and tick
**resolve** there if you have edited the source list.

Weekly rather than monthly on purpose: release dates move constantly, and a date
that shifted three weeks ago is worse than no date at all.

The job does not run on push. A push already deploys, and re-fetching on every
markup change would spend API quota for nothing.

## What it can and cannot see

The honest version, because a calendar you cannot trust is worse than no calendar.

**Solid.** TMDB carries release dates per country, so the Irish and British dates
are real dates rather than US dates with the numbers changed. The big theatrical
distributors, the broadcasters and the streaming services are all well covered.

**The safety net.** Alongside the per-source queries there is a wide net: every
documentary with an Irish or British release date in the window, whoever is
behind it. TMDB's company credits on unreleased titles are patchy, so a Dogwoof
release nobody has tagged yet still appears - it just arrives labelled
*Unlisted distributor* instead of going missing. Untick "Include titles from
outside the list" to hide those.

**Thin.** Sales agents (Cinephil, Autlook, Deckert, Submarine) announce slates in
the trades months before TMDB has a record. Expect little from them
automatically.

**Not scraped.** Magnolia and Kino Lorber block automated readers outright;
Dogwoof and NEON are JavaScript apps with nothing in the HTML. Scrapers against
those four would break every few months, so there are none. TMDB covers all four
as companies instead.

The **Where this comes from** table at the bottom of the site says what each
source actually yielded. *Nothing dated* means quiet; *not on TMDB* means it
needs help.

## Adding something by hand

Put it in `data/manual.json` and it survives every refresh. Entries there win
over anything TMDB found under the same title.

```json
{
  "title": "The One You Read About In Variety",
  "date": "2026-11-01",
  "dateRegion": "IE",
  "dateType": "theatrical",
  "sources": ["cinephil"],
  "director": "Someone",
  "overview": "One or two sentences."
}
```

Only `title`, `date` and `sources` are required. If all you know is the month,
use the first of it.

## Where things live

| Path | What it is |
| --- | --- |
| `data/sources.json` | The twenty-five sources. Hand-edited; everything else is generated |
| `data/sources.resolved.json` | Generated once. TMDB ids for each source |
| `data/manual.json` | Hand-added releases the automation cannot see |
| `data/releases.json` | Generated weekly. The only thing the site is built from |
| `.env` | Your TMDB key. Gitignored, never committed |
| `scripts/tmdb.mjs` | TMDB client: auth, rate limiting, retries |
| `scripts/resolve-sources.mjs` | Names to TMDB ids, printed for a human to check |
| `scripts/fetch.mjs` | The weekly job: collect, enrich, attribute |
| `scripts/demo-data.mjs` | Invented data for looking at the layout |
| `build.mjs` | Generates `dist/`, the calendar feed and the RSS feed |
| `vercel.json` | Build command, output directory and cache headers |
| `src/styles.css`, `src/app.js` | The stylesheet and the filtering |
| `dist/` | Generated. Don't edit by hand - it gets wiped on every build |

## Feeds

| File | For |
| --- | --- |
| `feed.ics` | Subscribe in Apple Calendar, Google Calendar or Outlook. Every release is an all-day event |
| `feed.xml` | RSS, for a reader |

Subscribe to the calendar by URL, not by download, or it will never update.

## Adding a source

Add an object to `sources` in `data/sources.json`, then re-run
`node scripts/resolve-sources.mjs` and check what it matched. Set
`"docsOnly": true` for an outfit that releases nothing but non-fiction - it
skips the genre filter, which matters because TMDB's genre data on unreleased
titles drops about half a slate.

---

This product uses the TMDB API but is not endorsed or certified by TMDB.
