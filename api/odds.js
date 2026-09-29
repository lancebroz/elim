// NFL moneylines via The Odds API, archived server-side in Vercel Blob.
// Env: ODDS_API_KEY (required), BLOB_READ_WRITE_TOKEN (from connected Blob store).
// Edge cache expires 7 AM & 2 PM Chicago; vercel.json crons ping after each boundary => 2 refreshes/day.
// Per game: DraftKings preferred when posted; otherwise median no-vig consensus of all
// other us-region books (BetOnline, Bovada, FanDuel, BetMGM, ...) — same 1 credit per call.
// Blob keeps FULL price history per game, each entry tagged with its source.

import { head, put } from '@vercel/blob';

const BLOB_PATH = 'nfl-2026/lines.json';

function secondsUntilNextRefreshChicago() {
  const now = new Date();
  const chi = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  let best = null;
  for (const hr of [7, 14]) {
    const b = new Date(chi);
    b.setHours(hr, 0, 0, 0);
    if (b <= chi) b.setDate(b.getDate() + 1);
    if (!best || b < best) best = b;
  }
  return Math.max(300, Math.round((best - chi) / 1000));
}

function implied(ml) { return ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100); }

async function readHistory() {
  try {
    const meta = await head(BLOB_PATH);
    const r = await fetch(`${meta.url}?v=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : {};
  } catch (e) {
    return {};
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
      `?apiKey=${key}&regions=us&markets=h2h&oddsFormat=american`
    );
    if (r.ok) {
      const games = await r.json();
      fetched = new Date().toISOString();
      for (const g of games) {
        let dkOdds = null;
        const probs = [];
        for (const b of (g.bookmakers || [])) {
          const m = b.markets && b.markets.find((mk) => mk.key === 'h2h');
          if (!m) continue;
          const o = {};
          for (const x of m.outcomes) o[x.name] = x.price;
          const mlH = o[g.home_team], mlA = o[g.away_team];
          if (mlH == null || mlA == null) continue;
          const iH = implied(mlH), iA = implied(mlA);
          probs.push(iH / (iH + iA));
          if (b.key === 'draftkings') dkOdds = { mlH, mlA };
        }
        if (!probs.length) continue;

        const k = `${g.away_team}|${g.home_team}`;
        seen.add(k);
        const e = hist[k] || (hist[k] = { home: g.home_team, away: g.away_team, start: g.commence_time, prices: [] });
        e.start = g.commence_time;
        const last = e.prices[e.prices.length - 1];
        const lastBook = last ? (last.book || 'draftkings') : null;

        if (dkOdds) {
          if (!last || lastBook !== 'draftkings' || last.mlH !== dkOdds.mlH || last.mlA !== dkOdds.mlA) {
            e.prices.push({ ts: fetched, mlH: dkOdds.mlH, mlA: dkOdds.mlA, book: 'draftkings' });
          }
        } else {
          probs.sort((a, b) => a - b);
          const mid = Math.floor(probs.length / 2);
          const pH = +(probs.length % 2 ? probs[mid] : (probs[mid - 1] + probs[mid]) / 2).toFixed(4);
          if (!last || lastBook !== 'consensus' || Math.abs((last.pH ?? 0) - pH) >= 0.005) {
            e.prices.push({ ts: fetched, pH, book: 'consensus', n: probs.length });
          }
        }
        if (e.prices.length > 300) e.prices.splice(0, e.prices.length - 300);
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
      const out = {
        home: e.home, away: e.away, start: e.start,
        ts: last.ts,
        live: seen.has(`${e.away}|${e.home}`),
        book: last.book || 'draftkings',
      };
      if (last.pH != null) { out.pH = last.pH; out.n = last.n; }
      else out.odds = { [e.home]: last.mlH, [e.away]: last.mlA };
      return out;
    });

  res.setHeader('Cache-Control', `s-maxage=${fetched ? secondsUntilNextRefreshChicago() : 300}, stale-while-revalidate=86400`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ fetched, archived, games });
}
