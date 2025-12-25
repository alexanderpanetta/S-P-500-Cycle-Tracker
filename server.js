const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

let cache = { data: null, timestamp: 0 };
const CACHE_DURATION = 4 * 60 * 60 * 1000;

async function fetchFRED(series) {
  try {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`;
    const response = await axios.get(url, { timeout: 10000 });
    const lines = response.data.trim().split('\n');
    const data = [];
    for (let i = 1; i < lines.length; i++) {
      const [date, value] = lines[i].split(',');
      if (value && value !== '.') {
        data.push({ date, value: parseFloat(value) });
      }
    }
    return data;
  } catch (error) {
    console.error(`Error fetching FRED ${series}:`, error.message);
    return null;
  }
}

async function scrapeCAPE() {
  try {
    const url = 'https://www.multpl.com/shiller-pe';
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = response.data;
    const match = html.match(/Current Shiller PE Ratio is[^<]*<[^>]*>(\d+\.?\d*)/i);
    if (match && match[1]) return parseFloat(match[1]);
    const backupMatch = html.match(/<big[^>]*>(\d+\.?\d*)<\/big>/);
    if (backupMatch && backupMatch[1]) return parseFloat(backupMatch[1]);
    return null;
  } catch (error) {
    console.error('Error scraping CAPE:', error.message);
    return null;
  }
}

async function scrapeYahooSP500() {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d';
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = response.data;
    if (data.chart && data.chart.result && data.chart.result[0]) {
      const quote = data.chart.result[0].meta;
      return { price: quote.regularMarketPrice, high52w: quote.fiftyTwoWeekHigh, low52w: quote.fiftyTwoWeekLow };
    }
    return null;
  } catch (error) {
    console.error('Error fetching Yahoo S&P 500:', error.message);
    return null;
  }
}

function calculateBuffettIndicator(wilshire, gdp) {
  if (!wilshire || !gdp || wilshire.length === 0 || gdp.length === 0) return null;
  const latestWilshire = wilshire[wilshire.length - 1];
  const latestGDP = gdp[gdp.length - 1];
  const marketCapBillions = latestWilshire.value * 1.05;
  const gdpBillions = latestGDP.value;
  return {
    value: Math.round((marketCapBillions / gdpBillions) * 1000) / 10,
    date: latestWilshire.date,
    marketCap: marketCapBillions,
    gdp: gdpBillions
  };
}

async function getCurrentData() {
  const now = Date.now();
  if (cache.data && (now - cache.timestamp) < CACHE_DURATION) return cache.data;
  
  console.log('Fetching fresh data...');
  const [wilshire, gdp, baa10y, cape, sp500Yahoo] = await Promise.all([
    fetchFRED('WILL5000INDFC'),
    fetchFRED('GDP'),
    fetchFRED('BAA10Y'),
    scrapeCAPE(),
    scrapeYahooSP500(),
  ]);
  
  const buffett = calculateBuffettIndicator(wilshire, gdp);
  const latestSpread = baa10y && baa10y.length > 0 ? baa10y[baa10y.length - 1] : null;
  
  const data = {
    timestamp: new Date().toISOString(),
    indicators: {
      cape: cape || 38.0,
      buffett: buffett ? buffett.value : 200,
      creditSpread: latestSpread ? latestSpread.value : 1.8,
      sp500: sp500Yahoo ? sp500Yahoo.price : null,
    },
    sp500Details: sp500Yahoo || { price: null, high52w: null, low52w: null },
    metadata: {
      buffettDate: buffett ? buffett.date : null,
      spreadDate: latestSpread ? latestSpread.date : null,
      capeSource: cape ? 'multpl.com (live)' : 'fallback',
    }
  };
  
  cache.data = data;
  cache.timestamp = now;
  return data;
}

app.get('/api/current', async (req, res) => {
  try {
    const data = await getCurrentData();
    res.json(data);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cached: !!cache.data });
});

app.get('/api/refresh', async (req, res) => {
  cache.data = null;
  cache.timestamp = 0;
  const data = await getCurrentData();
  res.json({ refreshed: true, data });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`S&P 500 Cycle Tracker API running on port ${PORT}`);
});
