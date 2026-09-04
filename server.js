const express = require('express');
const cors = require('cors');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());

// FRED API
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_API_KEY = process.env.FRED_API_KEY || 'f70e01eb152c2ee5828ff8d457ff3e4f';

// Shiller data - resolve the current download URL dynamically from shillerdata.com
const SHILLER_PAGE_URL = 'https://shillerdata.com/';
let resolvedShillerUrl = null;

async function getShillerUrl() {
    // Return cached URL if we resolved it recently (cache for 24 hours)
    if (resolvedShillerUrl && Date.now() - resolvedShillerUrl.timestamp < 24 * 60 * 60 * 1000) {
        return resolvedShillerUrl.url;
    }

    try {
        console.log('Resolving Shiller download URL from shillerdata.com...');
        const response = await fetch(SHILLER_PAGE_URL);
        const html = await response.text();

        // Look for the ie_data.xls download link in the page HTML
        const match = html.match(/(?:https?:)?\/\/img1\.wsimg\.com\/blobby\/go\/[^"'\s]+ie_data\.xls[^"'\s]*/i);
        if (match) {
            let url = match[0];
            // Ensure it has a protocol
            if (url.startsWith('//')) url = 'https:' + url;
            // Strip any cache-busting query params for cleaner caching
            url = url.split('?')[0];
            resolvedShillerUrl = { url, timestamp: Date.now() };
            console.log('Resolved Shiller URL:', url);
            return url;
        }

        throw new Error('Could not find ie_data.xls link on shillerdata.com');
    } catch (error) {
        console.error('Failed to resolve Shiller URL:', error.message);
        // Fall back to last known URL
        if (resolvedShillerUrl) return resolvedShillerUrl.url;
        // Last-resort hardcoded fallback
        return 'https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/downloads/3228b83a-7bad-4e69-b405-71e3a1ca6351/ie_data.xls';
    }
}

// Cache storage
const cache = {
    creditSpread: { data: null, timestamp: 0 },
    buffett: { data: null, timestamp: 0 },
    cape: { data: null, timestamp: 0 },
    shillerData: { data: null, timestamp: 0 },
    historicalCape: { data: null, timestamp: 0 },
    historicalBuffett: { data: null, timestamp: 0 }
};

const CACHE_DURATION = {
    creditSpread: 60 * 60 * 1000,         // 1 hour
    buffett: 24 * 60 * 60 * 1000,         // 24 hours
    cape: 24 * 60 * 60 * 1000,            // 24 hours
    shillerData: 24 * 60 * 60 * 1000,     // 24 hours
    historicalCape: 24 * 60 * 60 * 1000,  // 24 hours
    historicalBuffett: 24 * 60 * 60 * 1000 // 24 hours
};

// Historical percentile data
const HISTORICAL = {
    creditSpread: {
        getPercentile: (value) => {
            // Empirical quantiles from 10,168 daily BAA10Y observations, 1986-2026
            const percentiles = [
                { value: 1.16, pct: 0 }, { value: 1.50, pct: 5 }, { value: 1.57, pct: 10 },
                { value: 1.74, pct: 25 }, { value: 2.13, pct: 50 }, { value: 2.66, pct: 75 },
                { value: 3.11, pct: 90 }, { value: 3.32, pct: 95 }, { value: 6.16, pct: 100 }
            ];
            return interpolatePercentile(value, percentiles);
        }
    },
    cape: {
        getPercentile: (value) => {
            // Empirical quantiles from 1,749 months of Shiller CAPE data, 1881-2026
            const percentiles = [
                { value: 4.78, pct: 0 }, { value: 9.31, pct: 10 }, { value: 12.01, pct: 25 },
                { value: 16.61, pct: 50 }, { value: 21.55, pct: 75 }, { value: 28.30, pct: 90 },
                { value: 33.03, pct: 95 }, { value: 38.58, pct: 98 }, { value: 41.23, pct: 99 },
                { value: 44.20, pct: 100 }
            ];
            return interpolatePercentile(value, percentiles);
        }
    },
    buffett: {
        getPercentile: (value) => {
            // Empirical quantiles from 302 quarters of FRED Z.1 market cap / GDP, 1947-2026
            const percentiles = [
                { value: 35.9, pct: 0 }, { value: 47.0, pct: 10 }, { value: 59.2, pct: 25 },
                { value: 84.3, pct: 50 }, { value: 120.8, pct: 75 }, { value: 164.6, pct: 90 },
                { value: 201.7, pct: 95 }, { value: 234.0, pct: 98 }, { value: 245.1, pct: 99 },
                { value: 264.6, pct: 100 }
            ];
            return interpolatePercentile(value, percentiles);
        }
    }
};

// Empirical percentile rank: share of historical observations below `value`.
// This is what the site's methodology actually describes ("vs. all monthly
// observations since 1881" / "all quarterly observations since 1947"), so it is
// computed from the live source series rather than a hand-maintained table.
function percentileRank(value, values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    if (!Number.isFinite(value)) return null;
    let below = 0;
    for (const v of values) {
        if (Number.isFinite(v) && v < value) below++;
    }
    return (below / values.length) * 100;
}

// Round to the nearest 0.5 (whole numbers and .5 only)
function roundToHalf(x) {
    return Math.round(x * 2) / 2;
}

// Live CAPE percentile, falling back to the static table if Shiller is unreachable
async function getCapePercentile(value) {
    try {
        const hist = await fetchHistoricalCape();
        const pct = percentileRank(value, (hist.full || []).map(p => p.value));
        if (pct !== null) return { exact: pct, source: 'live', n: hist.full.length };
    } catch (e) {
        console.error('Live CAPE percentile failed, using table:', e.message);
    }
    return { exact: HISTORICAL.cape.getPercentile(value), source: 'table', n: null };
}

// Live Buffett percentile, falling back to the static table if FRED is unreachable
async function getBuffettPercentile(value) {
    try {
        const hist = await fetchHistoricalBuffett();
        const pct = percentileRank(value, (hist.full || []).map(p => p.value));
        if (pct !== null) return { exact: pct, source: 'live', n: hist.full.length };
    } catch (e) {
        console.error('Live Buffett percentile failed, using table:', e.message);
    }
    return { exact: HISTORICAL.buffett.getPercentile(value), source: 'table', n: null };
}

function interpolatePercentile(value, percentiles) {
    if (value <= percentiles[0].value) return percentiles[0].pct;
    if (value >= percentiles[percentiles.length - 1].value) return 100;

    for (let i = 1; i < percentiles.length; i++) {
        if (value <= percentiles[i].value) {
            const prev = percentiles[i - 1];
            const curr = percentiles[i];
            const ratio = (value - prev.value) / (curr.value - prev.value);
            return Math.round(prev.pct + ratio * (curr.pct - prev.pct));
        }
    }
    return 100;
}

function isCacheValid(key) {
    return cache[key].data && (Date.now() - cache[key].timestamp < CACHE_DURATION[key]);
}

// Fetch and parse Shiller Excel data (latest value only)
async function fetchShillerData() {
    if (isCacheValid('shillerData')) {
        return cache.shillerData.data;
    }

    try {
        const shillerUrl = await getShillerUrl();
        console.log('Fetching Shiller data from:', shillerUrl);
        const response = await fetch(shillerUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const workbook = XLSX.read(buffer, { type: 'buffer' });

        console.log('Available sheets:', workbook.SheetNames);

        // Find the sheet with data - try "Data" first, then the largest sheet
        let sheetName = workbook.SheetNames.find(name => name.toLowerCase() === 'data')
                     || workbook.SheetNames.find(name => name.toLowerCase().includes('data'))
                     || workbook.SheetNames[0];

        // If first sheet is small (like a disclaimer), try the next one
        let sheet = workbook.Sheets[sheetName];
        let data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        console.log('Trying sheet:', sheetName, 'rows:', data.length);

        // If this sheet has very few rows, try other sheets
        if (data.length < 50 && workbook.SheetNames.length > 1) {
            for (const name of workbook.SheetNames) {
                if (name === sheetName) continue;
                const testSheet = workbook.Sheets[name];
                const testData = XLSX.utils.sheet_to_json(testSheet, { header: 1 });
                console.log('Trying sheet:', name, 'rows:', testData.length);
                if (testData.length > data.length) {
                    sheetName = name;
                    sheet = testSheet;
                    data = testData;
                }
            }
        }

        console.log('Using sheet:', sheetName, 'with', data.length, 'rows');

        let capeColumnIndex = 12; // Column M in Excel (0-indexed)
        let headerRowIndex = 8;   // Data starts at row 9 (0-indexed = 8)

        // Get the latest non-empty CAPE value
        let latestCape = null;
        let latestDate = null;

        for (let i = data.length - 1; i > headerRowIndex; i--) {
            const row = data[i];
            if (row && row[capeColumnIndex] !== undefined && row[capeColumnIndex] !== null && row[capeColumnIndex] !== '') {
                const capeValue = parseFloat(row[capeColumnIndex]);
                if (!isNaN(capeValue) && capeValue > 0) {
                    latestCape = capeValue;
                    latestDate = row[0]; // Date is usually first column
                    console.log('Found CAPE value:', latestCape, 'at row', i, 'date:', latestDate);
                    break;
                }
            }
        }

        const result = {
            cape: latestCape,
            date: latestDate,
            source: 'Shiller/Yale',
            fetchedAt: new Date().toISOString()
        };

        cache.shillerData = { data: result, timestamp: Date.now() };
        console.log('Shiller data fetched:', result);
        return result;

    } catch (error) {
        console.error('Error fetching Shiller data:', error);
        if (cache.shillerData.data) {
            return cache.shillerData.data;
        }
        return { cape: 38.2, date: 'fallback', source: 'static', error: error.message };
    }
}

// Fetch FULL historical CAPE data from Shiller Excel
async function fetchHistoricalCape() {
    if (isCacheValid('historicalCape')) {
        return cache.historicalCape.data;
    }

    try {
        const shillerUrl = await getShillerUrl();
        console.log('Fetching historical CAPE data from:', shillerUrl);
        const response = await fetch(shillerUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const workbook = XLSX.read(buffer, { type: 'buffer' });

        // Find the data sheet
        let sheetName = workbook.SheetNames.find(name => name.toLowerCase() === 'data')
                     || workbook.SheetNames.find(name => name.toLowerCase().includes('data'))
                     || workbook.SheetNames[0];

        let sheet = workbook.Sheets[sheetName];
        let data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        // If this sheet has very few rows, try other sheets
        if (data.length < 50 && workbook.SheetNames.length > 1) {
            for (const name of workbook.SheetNames) {
                if (name === sheetName) continue;
                const testSheet = workbook.Sheets[name];
                const testData = XLSX.utils.sheet_to_json(testSheet, { header: 1 });
                if (testData.length > data.length) {
                    sheetName = name;
                    sheet = testSheet;
                    data = testData;
                }
            }
        }

        const capeColumnIndex = 12; // Column M - CAPE
        const headerRowIndex = 8;   // Data starts at row 9

        const historicalData = [];

        for (let i = headerRowIndex + 1; i < data.length; i++) {
            const row = data[i];
            if (!row || row[0] === undefined || row[0] === null || row[0] === '') continue;

            const dateValue = row[0];
            const capeValue = parseFloat(row[capeColumnIndex]);

            if (isNaN(capeValue) || capeValue <= 0) continue;

            // Parse date - Shiller uses decimal format like 1881.01
            let year, month;
            if (typeof dateValue === 'number') {
                year = Math.floor(dateValue);
                month = Math.round((dateValue - year) * 100);
                if (month === 0) month = 1;
            } else {
                continue;
            }

            // Skip invalid years
            if (year < 1881 || year > 2100) continue;

            historicalData.push({
                year: year,
                month: month,
                date: `${year}-${String(month).padStart(2, '0')}`,
                value: Math.round(capeValue * 100) / 100
            });
        }

        console.log(`Parsed ${historicalData.length} CAPE data points`);

        // Sample to ~50 points for charting (yearly averages for older data, monthly for recent)
        const sampledData = sampleCapeData(historicalData);

        const result = {
            full: historicalData,
            sampled: sampledData,
            count: historicalData.length,
            startDate: historicalData[0]?.date,
            endDate: historicalData[historicalData.length - 1]?.date,
            fetchedAt: new Date().toISOString()
        };

        cache.historicalCape = { data: result, timestamp: Date.now() };
        return result;

    } catch (error) {
        console.error('Error fetching historical CAPE:', error);
        return { error: error.message, sampled: [], full: [] };
    }
}

// Sample CAPE data for charting
function sampleCapeData(data) {
    if (!data || data.length === 0) return [];

    const sampled = [];
    const currentYear = new Date().getFullYear();

    // Group by year
    const byYear = {};
    for (const point of data) {
        if (!byYear[point.year]) {
            byYear[point.year] = [];
        }
        byYear[point.year].push(point.value);
    }

    // For years before 2000, take yearly average every 5-10 years
    // For 2000+, take yearly averages
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);

    for (const year of years) {
        const values = byYear[year];
        const avg = values.reduce((a, b) => a + b, 0) / values.length;

        if (year < 1950) {
            // Every 10 years + key years
            if (year % 10 === 0 || year === 1929 || year === 1932 || year === 1921) {
                sampled.push({ year, value: Math.round(avg * 10) / 10 });
            }
        } else if (year < 2000) {
            // Every 5 years + key years
            if (year % 5 === 0 || year === 1966 || year === 1974 || year === 1982 || year === 1987) {
                sampled.push({ year, value: Math.round(avg * 10) / 10 });
            }
        } else {
            // Every year for recent data
            sampled.push({ year, value: Math.round(avg * 10) / 10 });
        }
    }

    return sampled;
}

// Fetch historical Buffett Indicator from FRED
async function fetchHistoricalBuffett() {
    if (isCacheValid('historicalBuffett')) {
        return cache.historicalBuffett.data;
    }

    try {
        console.log('Fetching historical Buffett data from FRED...');

        // Fetch all historical data for both series
        const [mcResponse, gdpResponse] = await Promise.all([
            fetch(`${FRED_BASE}?series_id=BOGZ1LM883164115Q&api_key=${FRED_API_KEY}&file_type=json&sort_order=asc`),
            fetch(`${FRED_BASE}?series_id=GDP&api_key=${FRED_API_KEY}&file_type=json&sort_order=asc`)
        ]);

        const mcData = await mcResponse.json();
        const gdpData = await gdpResponse.json();

        if (!mcData.observations || !gdpData.observations) {
            throw new Error('No data from FRED');
        }

        // Create lookup for GDP by quarter
        const gdpByQuarter = {};
        for (const obs of gdpData.observations) {
            if (obs.value === '.') continue;
            const date = obs.date.substring(0, 7); // YYYY-MM
            gdpByQuarter[date] = parseFloat(obs.value) * 1000; // Convert to millions
        }

        const historicalData = [];

        for (const obs of mcData.observations) {
            if (obs.value === '.') continue;

            const date = obs.date.substring(0, 7);
            const marketCap = parseFloat(obs.value);
            const gdp = gdpByQuarter[date];

            if (!gdp || isNaN(marketCap)) continue;

            const buffettValue = (marketCap / gdp) * 100;
            const year = parseInt(obs.date.substring(0, 4));
            const quarter = Math.ceil(parseInt(obs.date.substring(5, 7)) / 3);

            historicalData.push({
                year: year,
                quarter: quarter,
                date: obs.date,
                value: Math.round(buffettValue)
            });
        }

        console.log(`Parsed ${historicalData.length} Buffett data points`);

        // Sample for charting
        const sampledData = sampleBuffettData(historicalData);

        const result = {
            full: historicalData,
            sampled: sampledData,
            count: historicalData.length,
            startDate: historicalData[0]?.date,
            endDate: historicalData[historicalData.length - 1]?.date,
            fetchedAt: new Date().toISOString()
        };

        cache.historicalBuffett = { data: result, timestamp: Date.now() };
        return result;

    } catch (error) {
        console.error('Error fetching historical Buffett:', error);
        return { error: error.message, sampled: [], full: [] };
    }
}

// Sample Buffett data for charting
function sampleBuffettData(data) {
    if (!data || data.length === 0) return [];

    const sampled = [];

    // Group by year, take Q4 or latest available
    const byYear = {};
    for (const point of data) {
        if (!byYear[point.year] || point.quarter >= byYear[point.year].quarter) {
            byYear[point.year] = point;
        }
    }

    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);

    for (const year of years) {
        const point = byYear[year];

        if (year < 1980) {
            // Every 5 years + key years
            if (year % 5 === 0 || year === 1974 || year === 1982) {
                sampled.push({ year, value: point.value });
            }
        } else if (year < 2000) {
            // Every 3 years + key years
            if (year % 3 === 0 || year === 1987 || year === 1990) {
                sampled.push({ year, value: point.value });
            }
        } else {
            // Every year for recent data
            sampled.push({ year, value: point.value });
        }
    }

    return sampled;
}

// NEW ENDPOINT: Historical data for charts
app.get('/api/historical', async (req, res) => {
    try {
        const [capeHistory, buffettHistory] = await Promise.all([
            fetchHistoricalCape(),
            fetchHistoricalBuffett()
        ]);

        res.json({
            cape: {
                data: capeHistory.sampled,
                fullCount: capeHistory.count,
                startDate: capeHistory.startDate,
                endDate: capeHistory.endDate
            },
            buffett: {
                data: buffettHistory.sampled,
                fullCount: buffettHistory.count,
                startDate: buffettHistory.startDate,
                endDate: buffettHistory.endDate
            },
            isLive: !capeHistory.error && !buffettHistory.error,
            updatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Historical data error:', error);
        res.status(500).json({
            error: error.message,
            isLive: false,
            cape: { data: [] },
            buffett: { data: [] }
        });
    }
});

// Latest Buffett Indicator — market cap and GDP MUST come from the same quarter.
// FRED publishes GDP about a month after quarter end but the Z.1 market cap series
// about ten weeks after, so each series' newest observation is usually a different
// quarter. Dividing the latest market cap by a *later* quarter's GDP understates the
// ratio (and disagrees with the chart, which joins on quarter).
async function fetchLatestBuffett() {
    const historical = await fetchHistoricalBuffett();
    const full = historical && historical.full;

    if (full && full.length > 0) {
        const latest = full[full.length - 1];
        const allTimeHigh = full.reduce((max, p) => Math.max(max, p.value), 0);
        return {
            value: latest.value,
            marketCapDate: latest.date,
            gdpDate: latest.date,
            allTimeHigh: allTimeHigh,
            isAllTimeHigh: latest.value >= allTimeHigh
        };
    }

    // Fallback: pair the newest quarter present in BOTH series
    const [mcData, gdpData] = await Promise.all([
        fetch(`${FRED_BASE}?series_id=BOGZ1LM883164115Q&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=12`).then(r => r.json()),
        fetch(`${FRED_BASE}?series_id=GDP&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=12`).then(r => r.json())
    ]);

    const gdpByQuarter = {};
    for (const obs of (gdpData.observations || [])) {
        if (obs.value !== '.') gdpByQuarter[obs.date] = parseFloat(obs.value) * 1000;
    }

    for (const obs of (mcData.observations || [])) {
        if (obs.value === '.') continue;
        const gdp = gdpByQuarter[obs.date];
        if (!gdp) continue;
        return {
            value: Math.round((parseFloat(obs.value) / gdp) * 100),
            marketCapDate: obs.date,
            gdpDate: obs.date,
            allTimeHigh: null,
            isAllTimeHigh: false
        };
    }

    throw new Error('No quarter with both market cap and GDP data');
}

// Endpoint: Credit Spread
app.get('/api/credit-spread', async (req, res) => {
    try {
        if (isCacheValid('creditSpread')) {
            return res.json(cache.creditSpread.data);
        }

        const url = `${FRED_BASE}?series_id=BAA10Y&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.observations && data.observations.length > 0) {
            const latest = data.observations[0];
            const value = parseFloat(latest.value);
            const percentile = HISTORICAL.creditSpread.getPercentile(value);

            const result = {
                value: value,
                percentile: percentile,
                date: latest.date,
                updatedAt: new Date().toISOString()
            };

            cache.creditSpread = { data: result, timestamp: Date.now() };
            return res.json(result);
        }

        throw new Error('No data from FRED');
    } catch (error) {
        console.error('Credit spread error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint: Buffett Indicator
app.get('/api/buffett', async (req, res) => {
    try {
        if (isCacheValid('buffett')) {
            return res.json(cache.buffett.data);
        }

        const latest = await fetchLatestBuffett();

        const pct = await getBuffettPercentile(latest.value);
        const result = {
            value: latest.value,
            percentile: Math.round(pct.exact),
            percentileExact: Math.round(pct.exact * 10) / 10,
            percentileSource: pct.source,
            observations: pct.n,
            marketCapDate: latest.marketCapDate,
            gdpDate: latest.gdpDate,
            isAllTimeHigh: latest.isAllTimeHigh,
            updatedAt: new Date().toISOString()
        };

        cache.buffett = { data: result, timestamp: Date.now() };
        return res.json(result);
    } catch (error) {
        console.error('Buffett error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint: CAPE (from Shiller Excel)
app.get('/api/cape', async (req, res) => {
    try {
        if (isCacheValid('cape')) {
            return res.json(cache.cape.data);
        }

        const shillerData = await fetchShillerData();
        const pct = await getCapePercentile(shillerData.cape);

        const result = {
            value: shillerData.cape,
            percentile: Math.round(pct.exact),
            percentileExact: Math.round(pct.exact * 10) / 10,
            percentileSource: pct.source,
            observations: pct.n,
            date: shillerData.date,
            source: shillerData.source,
            updatedAt: new Date().toISOString()
        };

        cache.cape = { data: result, timestamp: Date.now() };
        return res.json(result);
    } catch (error) {
        console.error('CAPE error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint: All indicators (main endpoint for frontend)
app.get('/api/indicators', async (req, res) => {
    try {
        // Fetch all data in parallel
        const [shillerData, creditResponse, buffettLatest, sp500Response] = await Promise.all([
            fetchShillerData(),
            fetch(`${FRED_BASE}?series_id=BAA10Y&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`).then(r => r.json()),
            fetchLatestBuffett(),
            fetch(`${FRED_BASE}?series_id=SP500&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`).then(r => r.json()),
            fetchHistoricalCape()   // warms the 24h cache the CAPE percentile reads
        ]);

        // Parse CAPE
        const capeValue = shillerData.cape;
        const capePct = await getCapePercentile(capeValue);
        const capePercentile = Math.round(capePct.exact);

        // Parse Credit Spread
        const creditValue = parseFloat(creditResponse.observations[0].value);
        const creditPercentile = HISTORICAL.creditSpread.getPercentile(creditValue);

        // Parse Buffett (market cap and GDP joined on the same quarter)
        const buffettValue = buffettLatest.value;
        console.log('Buffett calc:', buffettLatest);
        const buffettPct = await getBuffettPercentile(buffettValue);
        const buffettPercentile = Math.round(buffettPct.exact);

        // Composite score = average of the two percentile ranks, computed from the
        // unrounded ranks and then snapped to the nearest 0.5
        const compositeScore = roundToHalf((capePct.exact + buffettPct.exact) / 2);

        // Get S&P 500 price from FRED
        const sp500Value = parseFloat(sp500Response.observations[0].value);
        const sp500Date = sp500Response.observations[0].date;

        res.json({
            score: compositeScore,
            sp500: {
                value: sp500Value,
                date: sp500Date,
                timestamp: new Date(sp500Date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' close',
                source: 'FRED/S&P Dow Jones'
            },
            cape: {
                value: capeValue,
                percentile: capePercentile,
                percentileExact: Math.round(capePct.exact * 10) / 10,
                percentileSource: capePct.source,
                observations: capePct.n,
                date: shillerData.date,
                source: 'Shiller/Yale'
            },
            buffett: {
                value: buffettValue,
                percentile: buffettPercentile,
                percentileExact: Math.round(buffettPct.exact * 10) / 10,
                percentileSource: buffettPct.source,
                observations: buffettPct.n,
                date: buffettLatest.marketCapDate,
                isAllTimeHigh: buffettLatest.isAllTimeHigh
            },
            creditSpread: {
                value: creditValue,
                percentile: creditPercentile,
                date: creditResponse.observations[0].date
            },
            isLive: true,
            updatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Indicators error:', error);
        // Fallback to static data
        res.json({
            score: 99,
            sp500: { value: 6845.50, timestamp: 'Dec 31 close', source: 'static' },
            cape: { value: 39.4, percentile: 98, source: 'static' },
            buffett: { value: 244, percentile: 99, isAllTimeHigh: true },
            creditSpread: { value: 1.69, percentile: 19 },
            isLive: false,
            error: error.message,
            updatedAt: new Date().toISOString()
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        hasApiKey: !!FRED_API_KEY,
        cacheStatus: {
            cape: isCacheValid('cape') ? 'valid' : 'expired',
            buffett: isCacheValid('buffett') ? 'valid' : 'expired',
            creditSpread: isCacheValid('creditSpread') ? 'valid' : 'expired',
            historicalCape: isCacheValid('historicalCape') ? 'valid' : 'expired',
            historicalBuffett: isCacheValid('historicalBuffett') ? 'valid' : 'expired'
        },
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'S&P 500 Cycle Tracker API',
        endpoints: [
            '/api/indicators - All indicators (recommended)',
            '/api/historical - Historical time series for charts (NEW)',
            '/api/cape - CAPE ratio from Shiller data',
            '/api/buffett - Buffett Indicator from FRED',
            '/api/credit-spread - Credit spread from FRED',
            '/api/health - Health check'
        ]
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
