const express = require('express');
const Parser = require('rss-parser');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)' }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const SOURCES = [
  { name: 'BBC News',               country: 'UK',          flag: '🇬🇧', url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                      region: 'Europe'      },
  { name: 'Al Jazeera',             country: 'Qatar',       flag: '🇶🇦', url: 'https://www.aljazeera.com/xml/rss/all.xml',                        region: 'Middle East' },
  { name: 'Deutsche Welle',         country: 'Germany',     flag: '🇩🇪', url: 'https://rss.dw.com/rdf/rss-en-world',                              region: 'Europe'      },
  { name: 'France 24',              country: 'France',      flag: '🇫🇷', url: 'https://www.france24.com/en/rss',                                  region: 'Europe'      },
  { name: 'NHK World',              country: 'Japan',       flag: '🇯🇵', url: 'https://www3.nhk.or.jp/nhkworld/en/news/feeds/latest.xml',          region: 'Asia'        },
  { name: 'The Hindu',              country: 'India',       flag: '🇮🇳', url: 'https://www.thehindu.com/news/international/feeder/default.rss',    region: 'India'       },
  { name: 'The News Minute',        country: 'India',       flag: '🇮🇳', url: 'https://www.thenewsminute.com/feed',                                 region: 'India'       },
  { name: 'Newslaundry',            country: 'India',       flag: '🇮🇳', url: 'https://www.newslaundry.com/feed',                                   region: 'India'       },
  { name: 'ABC News Australia',     country: 'Australia',   flag: '🇦🇺', url: 'https://www.abc.net.au/news/feed/51120/rss.xml',                    region: 'Oceania'     },
  { name: 'The Guardian',           country: 'UK',          flag: '🇬🇧', url: 'https://www.theguardian.com/world/rss',                             region: 'Europe'      },
  { name: 'CGTN',                   country: 'China',       flag: '🇨🇳', url: 'https://www.cgtn.com/subscribe/rss/section/world.xml',              region: 'Asia'        },
  { name: 'RT News',                country: 'Russia',      flag: '🇷🇺', url: 'https://www.rt.com/rss/news/',                                     region: 'Europe/Asia' },
  { name: 'South China Morning Post', country: 'Hong Kong', flag: '🇭🇰', url: 'https://www.scmp.com/rss/91/feed',                                 region: 'Asia'        },
  { name: 'Financial Times',        country: 'UK',          flag: '🇬🇧', url: 'https://www.ft.com/?format=rss',                                   region: 'Europe'      },
  { name: 'NBC News',               country: 'USA',         flag: '🇺🇸', url: 'https://feeds.nbcnews.com/nbcnews/public/news',                     region: 'Americas'    },
  { name: 'Premium Times',          country: 'Nigeria',     flag: '🇳🇬', url: 'https://www.premiumtimesng.com/feed',                               region: 'Africa'      },
  { name: 'Africanews',             country: 'Pan-Africa',  flag: '🌍', url: 'https://www.africanews.com/feed/',                                   region: 'Africa'      },
  { name: 'Sahara Reporters',       country: 'Nigeria',     flag: '🇳🇬', url: 'https://saharareporters.com/rss.xml',                               region: 'Africa'      },
  { name: 'AllAfrica',              country: 'Pan-Africa',  flag: '🌍', url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf',    region: 'Africa'      },
  // ── Indian Cities ──
  { name: 'Deccan Chronicle',       country: 'India',       flag: '🇮🇳', url: 'https://www.deccanchronicle.com/rss_feed/bangalore.xml',              region: 'Bangalore'   }
];

const CATEGORIES = ['World Politics', 'Business & Economy', 'Conflict & Security', 'Technology', 'Climate & Environment', 'Science & Health', 'Society & Culture'];

// ── Twitter/X accounts via Nitter ─────────────────────────────────────────────
// Add/remove usernames here. Format: { username, label, flag }
const NITTER_BASE = 'https://nitter.net';
const TWITTER_ACCOUNTS = [
  { username: 'Reuters',        label: 'Reuters',          flag: '📰' },
  { username: 'BBCBreaking',    label: 'BBC Breaking',     flag: '🇬🇧' },
  { username: 'AJEnglish',      label: 'Al Jazeera',       flag: '🇶🇦' },
  { username: 'UN',             label: 'United Nations',   flag: '🌐' },
  // ── Add your own accounts below ──
  // { username: 'elonmusk',    label: 'Elon Musk',        flag: '🐦' },
  // { username: 'narendramodi', label: 'PM Modi',         flag: '🇮🇳' },
];

// ── Twitter/Nitter fetching ───────────────────────────────────────────────────

async function fetchTwitterAccount(account) {
  try {
    const url = `${NITTER_BASE}/${account.username}/rss`;
    const feed = await parser.parseURL(url);
    return feed.items.slice(0, 6).map(item => ({
      title: stripHtml(item.title || ''),
      link: (item.link || '').replace('nitter.net', 'twitter.com'),
      rawSummary: stripHtml(item.contentSnippet || item.content || item.title || ''),
      published: item.pubDate || item.isoDate || new Date().toISOString(),
      source: `@${account.username}`,
      label: account.label,
      country: 'Twitter/X',
      flag: account.flag,
      region: 'Twitter',
      image: extractImage(item),
      isTweet: true
    }));
  } catch (err) {
    console.error(`Failed to fetch @${account.username}: ${err.message}`);
    return [];
  }
}

// ── RSS fetching ──────────────────────────────────────────────────────────────

async function fetchFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 5).map(item => ({
      title: item.title || 'No title',
      link: item.link || item.guid || '#',
      rawSummary: stripHtml(item.contentSnippet || item.content || item.summary || ''),
      published: item.pubDate || item.isoDate || new Date().toISOString(),
      source: source.name,
      country: source.country,
      flag: source.flag,
      region: source.region,
      image: extractImage(item)
    }));
  } catch (err) {
    console.error(`Failed to fetch ${source.name}: ${err.message}`);
    return [];
  }
}

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

// ── Claude AI: summarise + categorise ────────────────────────────────────────

async function enrichWithAI(articles) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('No ANTHROPIC_API_KEY — skipping AI summaries');
    return articles.map(a => ({ ...a, summary: a.rawSummary, category: 'World Politics' }));
  }

  const input = articles.map((a, i) => ({
    id: i,
    title: a.title,
    source: `${a.source} (${a.country})`,
    snippet: a.rawSummary
  }));

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a neutral, factual news editor. For each article below, write an unbiased 2–3 sentence summary in plain English — no opinion, no spin, just facts. Also assign one category from this list: ${CATEGORIES.join(', ')}.

Return ONLY a JSON array, no other text. Each element: {"id": number, "summary": "...", "category": "..."}

Articles:
${JSON.stringify(input, null, 2)}`
      }]
    });

    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const results = JSON.parse(jsonStr);

    return articles.map((a, i) => {
      const r = results.find(x => x.id === i);
      return {
        ...a,
        summary: r?.summary || a.rawSummary,
        category: r?.category || 'World Politics'
      };
    });
  } catch (err) {
    console.error('AI enrichment failed:', err.message);
    return articles.map(a => ({ ...a, summary: a.rawSummary, category: 'World Politics' }));
  }
}

async function enrichTweetsWithAI(tweets) {
  if (!process.env.ANTHROPIC_API_KEY || tweets.length === 0) {
    return tweets.map(t => ({ ...t, summary: t.rawSummary, category: 'World Politics' }));
  }
  const input = tweets.map((t, i) => ({ id: i, account: t.source, text: t.rawSummary }));
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are a neutral news editor. For each tweet below, write a concise 1–2 sentence factual summary in plain English. Also assign one category from: ${CATEGORIES.join(', ')}.

Return ONLY a JSON array. Each element: {"id": number, "summary": "...", "category": "..."}

Tweets:
${JSON.stringify(input, null, 2)}`
      }]
    });
    const text = response.content[0].text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '');
    const results = JSON.parse(text);
    return tweets.map((t, i) => {
      const r = results.find(x => x.id === i);
      return { ...t, summary: r?.summary || t.rawSummary, category: r?.category || 'World Politics' };
    });
  } catch (err) {
    console.error('Tweet AI enrichment failed:', err.message);
    return tweets.map(t => ({ ...t, summary: t.rawSummary, category: 'World Politics' }));
  }
}

// ── Cache & API ───────────────────────────────────────────────────────────────

let cache = { articles: [], tweets: [], timestamp: 0, sources: [] };
const CACHE_TTL = 15 * 60 * 1000;

app.get('/api/news', async (req, res) => {
  const now = Date.now();
  if (now - cache.timestamp < CACHE_TTL && cache.articles.length > 0) {
    return res.json({ articles: cache.articles, cached: true, sources: cache.sources });
  }

  console.log('Fetching RSS feeds...');
  const results = await Promise.allSettled(SOURCES.map(fetchFeed));
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Deduplicate
  const seen = new Set();
  const unique = all.filter(a => {
    const key = a.title.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // Score & pick top 20
  const top = unique
    .map(a => ({ ...a, score: scoreArticle(a) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  console.log(`Fetched ${top.length} articles. Running AI summaries...`);
  const enriched = await enrichWithAI(top);

  // Fetch tweets in parallel (don't block news response)
  fetchAndCacheTweets();

  const sourcesLoaded = [...new Set(enriched.map(a => a.source))];
  cache = { ...cache, articles: enriched, timestamp: now, sources: sourcesLoaded };

  res.json({ articles: enriched, cached: false, sources: sourcesLoaded });
});

async function fetchAndCacheTweets() {
  try {
    console.log('Fetching Twitter/X accounts via Nitter...');
    const results = await Promise.allSettled(TWITTER_ACCOUNTS.map(fetchTwitterAccount));
    const allTweets = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    allTweets.sort((a, b) => new Date(b.published) - new Date(a.published));
    const top = allTweets.slice(0, 30);
    const enriched = await enrichTweetsWithAI(top);
    cache = { ...cache, tweets: enriched };
    console.log(`Cached ${enriched.length} tweets`);
  } catch (err) {
    console.error('Tweet fetch failed:', err.message);
  }
}

app.get('/api/tweets', async (req, res) => {
  if (cache.tweets.length === 0) await fetchAndCacheTweets();
  res.json({ tweets: cache.tweets, accounts: TWITTER_ACCOUNTS.map(a => ({ username: a.username, label: a.label, flag: a.flag })) });
});

app.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(s => ({ name: s.name, country: s.country, flag: s.flag, region: s.region })));
});

app.get('/api/categories', (req, res) => {
  res.json(CATEGORIES);
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n🌍 WorldPulse running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠  Set ANTHROPIC_API_KEY for AI summaries\n');
  } else {
    console.log('✅ AI summaries enabled (Claude Haiku)\n');
  }
});
