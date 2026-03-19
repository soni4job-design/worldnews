const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_KEY = defineSecret('ANTHROPIC_API_KEY');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)' }
});

const SOURCES = [
  { name: 'BBC News',               country: 'UK',          flag: '🇬🇧', url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                      region: 'Europe'      },
  { name: 'Al Jazeera',             country: 'Qatar',       flag: '🇶🇦', url: 'https://www.aljazeera.com/xml/rss/all.xml',                        region: 'Middle East' },
  { name: 'Deutsche Welle',         country: 'Germany',     flag: '🇩🇪', url: 'https://rss.dw.com/rdf/rss-en-world',                              region: 'Europe'      },
  { name: 'France 24',              country: 'France',      flag: '🇫🇷', url: 'https://www.france24.com/en/rss',                                  region: 'Europe'      },
  { name: 'NHK World',              country: 'Japan',       flag: '🇯🇵', url: 'https://www3.nhk.or.jp/nhkworld/en/news/feeds/latest.xml',          region: 'Asia'        },
  { name: 'The Hindu',              country: 'India',       flag: '🇮🇳', url: 'https://www.thehindu.com/news/international/feeder/default.rss',    region: 'India'       },
  { name: 'The News Minute',        country: 'India',       flag: '🇮🇳', url: 'https://www.thenewsminute.com/feed',                                region: 'India'       },
  { name: 'Newslaundry',            country: 'India',       flag: '🇮🇳', url: 'https://www.newslaundry.com/feed',                                  region: 'India'       },
  { name: 'ABC News Australia',     country: 'Australia',   flag: '🇦🇺', url: 'https://www.abc.net.au/news/feed/51120/rss.xml',                    region: 'Oceania'     },
  { name: 'The Guardian',           country: 'UK',          flag: '🇬🇧', url: 'https://www.theguardian.com/world/rss',                             region: 'Europe'      },
  { name: 'CGTN',                   country: 'China',       flag: '🇨🇳', url: 'https://www.cgtn.com/subscribe/rss/section/world.xml',              region: 'Asia'        },
  { name: 'RT News',                country: 'Russia',      flag: '🇷🇺', url: 'https://www.rt.com/rss/news/',                                     region: 'Europe/Asia' },
  { name: 'South China Morning Post', country: 'Hong Kong', flag: '🇭🇰', url: 'https://www.scmp.com/rss/91/feed',                                 region: 'Asia'        },
  { name: 'Financial Times',        country: 'UK',          flag: '🇬🇧', url: 'https://www.ft.com/?format=rss',                                   region: 'Europe'      },
  { name: 'NBC News',               country: 'USA',         flag: '🇺🇸', url: 'https://feeds.nbcnews.com/nbcnews/public/news',                     region: 'Americas'    },
  { name: 'Premium Times',          country: 'Nigeria',     flag: '🇳🇬', url: 'https://www.premiumtimesng.com/feed',                               region: 'Africa'      },
  { name: 'Africanews',             country: 'Pan-Africa',  flag: '🌍',  url: 'https://www.africanews.com/feed/',                                  region: 'Africa'      },
  { name: 'Sahara Reporters',       country: 'Nigeria',     flag: '🇳🇬', url: 'https://saharareporters.com/rss.xml',                               region: 'Africa'      },
  { name: 'AllAfrica',              country: 'Pan-Africa',  flag: '🌍',  url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf',   region: 'Africa'      },
  { name: 'Deccan Chronicle',       country: 'India',       flag: '🇮🇳', url: 'https://www.deccanchronicle.com/rss_feed/bangalore.xml',            region: 'Bangalore'   }
];

const CATEGORIES = ['World Politics', 'Business & Economy', 'Conflict & Security', 'Technology', 'Climate & Environment', 'Science & Health', 'Society & Culture'];

const NITTER_BASE = 'https://nitter.net';
const TWITTER_ACCOUNTS = [
  { username: 'Reuters',     label: 'Reuters',        flag: '📰' },
  { username: 'BBCBreaking', label: 'BBC Breaking',   flag: '🇬🇧' },
  { username: 'AJEnglish',   label: 'Al Jazeera',     flag: '🇶🇦' },
  { username: 'UN',          label: 'United Nations', flag: '🌐' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim().slice(0, 400);
}

function extractImage(item) {
  try {
    if (item.enclosure?.url) return item.enclosure.url;
    if (item['media:content']?.['$']?.url) return item['media:content']['$'].url;
    if (item.content) {
      const m = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) return m[1];
    }
  } catch (e) {}
  return null;
}

function scoreArticle(a) {
  const ageHours = (Date.now() - new Date(a.published).getTime()) / 3600000;
  const recency = Math.max(0, 100 - ageHours * 2);
  const keywords = ['war','conflict','peace','crisis','election','president','minister',
    'summit','climate','nuclear','UN','NATO','sanctions','treaty','earthquake',
    'disaster','pandemic','economy','trade','protest','coup','ceasefire','invasion'];
  const kw = keywords.reduce((s, k) => a.title.toLowerCase().includes(k) ? s + 10 : s, 0);
  return recency + kw;
}

// ── Fetching ──────────────────────────────────────────────────────────────────

async function fetchFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 5).map(item => ({
      title: item.title || 'No title',
      link: item.link || item.guid || '#',
      rawSummary: stripHtml(item.contentSnippet || item.content || item.summary || ''),
      published: item.pubDate || item.isoDate || new Date().toISOString(),
      source: source.name, country: source.country, flag: source.flag,
      region: source.region, image: extractImage(item)
    }));
  } catch (err) {
    console.error(`Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

async function fetchTwitterAccount(account) {
  try {
    const feed = await parser.parseURL(`${NITTER_BASE}/${account.username}/rss`);
    return feed.items.slice(0, 6).map(item => ({
      title: stripHtml(item.title || ''),
      link: (item.link || '').replace('nitter.net', 'twitter.com'),
      rawSummary: stripHtml(item.contentSnippet || item.content || item.title || ''),
      published: item.pubDate || item.isoDate || new Date().toISOString(),
      source: `@${account.username}`, label: account.label,
      country: 'Twitter/X', flag: account.flag, region: 'Twitter', isTweet: true,
      image: extractImage(item)
    }));
  } catch (err) {
    console.error(`Failed @${account.username}: ${err.message}`);
    return [];
  }
}

// ── AI Enrichment ─────────────────────────────────────────────────────────────

async function enrichWithAI(items, apiKey, prompt) {
  if (!apiKey || items.length === 0) {
    return items.map(a => ({ ...a, summary: a.rawSummary, category: 'World Politics' }));
  }
  const anthropic = new Anthropic({ apiKey });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const results = JSON.parse(text);
    return items.map((a, i) => {
      const r = results.find(x => x.id === i);
      return { ...a, summary: r?.summary || a.rawSummary, category: r?.category || 'World Politics' };
    });
  } catch (err) {
    console.error('AI enrichment failed:', err.message);
    return items.map(a => ({ ...a, summary: a.rawSummary, category: 'World Politics' }));
  }
}

// ── In-memory cache (per function instance) ──────────────────────────────────

let cache = { articles: [], tweets: [], timestamp: 0, sources: [] };
const CACHE_TTL = 15 * 60 * 1000;

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: true }));

app.get('/api/news', async (req, res) => {
  const now = Date.now();
  if (now - cache.timestamp < CACHE_TTL && cache.articles.length > 0) {
    return res.json({ articles: cache.articles, cached: true, sources: cache.sources });
  }

  const apiKey = ANTHROPIC_KEY.value();
  const results = await Promise.allSettled(SOURCES.map(fetchFeed));
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  const seen = new Set();
  const unique = all.filter(a => {
    const key = a.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  const top = unique
    .map(a => ({ ...a, score: scoreArticle(a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  const input = top.map((a, i) => ({ id: i, title: a.title, source: `${a.source} (${a.country})`, snippet: a.rawSummary }));
  const prompt = `You are a neutral, factual news editor. For each article below, write an unbiased 2–3 sentence summary in plain English — no opinion, no spin, just facts. Also assign one category from: ${CATEGORIES.join(', ')}.

Return ONLY a JSON array. Each element: {"id": number, "summary": "...", "category": "..."}

Articles:
${JSON.stringify(input, null, 2)}`;

  const enriched = await enrichWithAI(top, apiKey, prompt);
  const sourcesLoaded = [...new Set(enriched.map(a => a.source))];
  cache = { ...cache, articles: enriched, timestamp: now, sources: sourcesLoaded };

  res.json({ articles: enriched, cached: false, sources: sourcesLoaded });
});

app.get('/api/tweets', async (req, res) => {
  const apiKey = ANTHROPIC_KEY.value();
  const results = await Promise.allSettled(TWITTER_ACCOUNTS.map(fetchTwitterAccount));
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  all.sort((a, b) => new Date(b.published) - new Date(a.published));
  const top = all.slice(0, 30);

  const input = top.map((t, i) => ({ id: i, account: t.source, text: t.rawSummary }));
  const prompt = `You are a neutral news editor. For each tweet below, write a concise 1–2 sentence factual summary. Assign one category from: ${CATEGORIES.join(', ')}.

Return ONLY a JSON array. Each element: {"id": number, "summary": "...", "category": "..."}

Tweets:
${JSON.stringify(input, null, 2)}`;

  const enriched = await enrichWithAI(top, apiKey, prompt);
  res.json({ tweets: enriched, accounts: TWITTER_ACCOUNTS.map(a => ({ username: a.username, label: a.label, flag: a.flag })) });
});

app.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(s => ({ name: s.name, country: s.country, flag: s.flag, region: s.region })));
});

app.get('/api/categories', (req, res) => res.json(CATEGORIES));

// ── Export as Firebase Function ───────────────────────────────────────────────

exports.api = onRequest(
  { secrets: [ANTHROPIC_KEY], timeoutSeconds: 120, memory: '512MiB' },
  app
);
