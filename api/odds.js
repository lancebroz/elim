// DraftKings NFL moneylines via The Odds API, archived server-side in Vercel Blob.
// Env: ODDS_API_KEY (required), BLOB_READ_WRITE_TOKEN (auto-added when a Blob store is connected).
// Edge cache expires 7 AM Chicago daily => ~1 upstream call + 1 blob write per day.
// Blob keeps FULL price history per game: every distinct line with its timestamp.

import { head, put } from '@vercel/blob';

const BLOB_PATH = 'nfl-2026/lines.json';

function secondsUntilNext7amChicago() {
  const now = new Date();
  const chi = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const next = new Date(chi);
  next.setHours(7, 0, 0, 0);
  if (chi >= next) next.setDate(next.getDate() + 1);
  return Math.max(300, Math.round((next - chi) / 1000));
}

async function readHistory() {
  try {
    const meta = await head(BLOB_PATH);
    const r = await fetch(`${meta.url}?v=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : {};
  } catch (e) {
    return {}; // no store configured yet, or first run
  }
}

export default async function handler(req, res) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return res.status(500).json({ error: 'ODDS_API_KEY not set' });

  const hist = await readHistory();
  const seen = new Set();
  let fetched = null;

  try {
    const r = await fetch(
      'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/' +
      `?apiKey=${key}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`
    );
    if (r.ok) {
      const games = await r.json();
      fetched = new Date().toISOString();
      for (const g of games) {
        const dk = (g.bookmakers || []).find((b) => b.key === 'draftkings');
        const m = dk && dk.markets.find((mk) => mk.key === 'h2h');
        if (!m) continue;
        const odds = {};
        for (const o of m.outcomes) odds[o.name] = o.price;
        const mlH = odds[g.home_team], mlA = odds[g.away_team];
        if (mlH == null || mlA == null) continue;
        const k = `${g.away_team}|${g.home_team}`;
        seen.add(k);
        const e = hist[k] || (hist[k] = { home: g.home_team, away: g.away_team, start: g.commence_time, prices: [] });
        e.start = g.commence_time;
        const last = e.prices[e.prices.length - 1];
        if (!last || last.mlH !== mlH || last.mlA !== mlA) {
          e.prices.push({ ts: fetched, mlH, mlA });
          if (e.prices.length > 300) e.prices.splice(0, e.prices.length - 300);
        }
      }
    }
  } catch (e) { /* fall through: respond from archive */ }

  let archived = false;
  if (fetched) {
    try {
      await put(BLOB_PATH, JSON.stringify(hist), {
        access: 'public',
        allowOverwrite: true,
        contentType: 'application/json',
        cacheControlMaxAge: 60,
      });
      archived = true;
    } catch (e) { /* blob store not configured — lines still served, just not archived */ }
  } else {
    archived = Object.keys(hist).length > 0;
  }

  const games = Object.values(hist)
    .filter((e) => e.prices.length)
    .map((e) => {
      const last = e.prices[e.prices.length - 1];
      return {
        home: e.home, away: e.away, start: e.start,
        odds: { [e.home]: last.mlH, [e.away]: last.mlA },
        ts: last.ts,
        live: seen.has(`${e.away}|${e.home}`),
      };
    });

  res.setHeader('Cache-Control', `s-maxage=${fetched ? secondsUntilNext7amChicago() : 300}, stale-while-revalidate=86400`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ fetched, archived, games });
}
