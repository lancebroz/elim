// Vercel serverless function: DraftKings NFL moneylines via The Odds API.
// Requires env var ODDS_API_KEY (set in Vercel project settings — never commit the key).
// Edge cache expires at 7:00 AM Chicago time daily => ~1 upstream call per day.

function secondsUntilNext7amChicago() {
  const now = new Date();
  const chi = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const next = new Date(chi);
  next.setHours(7, 0, 0, 0);
  if (chi >= next) next.setDate(next.getDate() + 1);
  return Math.max(300, Math.round((next - chi) / 1000));
}

export default async function handler(req, res) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return res.status(500).json({ error: 'ODDS_API_KEY not set' });

  const url =
    'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/' +
    `?apiKey=${key}&regions=us&markets=h2h&bookmakers=draftkings&oddsFormat=american`;

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'upstream ' + r.status });
    const games = await r.json();

    const out = [];
    for (const g of games) {
      const dk = (g.bookmakers || []).find((b) => b.key === 'draftkings');
      const m = dk && dk.markets.find((mk) => mk.key === 'h2h');
      if (!m) continue;
      const odds = {};
      for (const o of m.outcomes) odds[o.name] = o.price;
      out.push({ home: g.home_team, away: g.away_team, start: g.commence_time, odds });
    }

    res.setHeader('Cache-Control', `s-maxage=${secondsUntilNext7amChicago()}, stale-while-revalidate=86400`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ fetched: new Date().toISOString(), games: out });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}
