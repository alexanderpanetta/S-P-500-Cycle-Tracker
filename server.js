const express = require('express');
const cors = require('cors');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());

// FRED API
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_API_KEY = process.env.FRED_API_KEY || 'f70e01eb152c2ee5828ff8d457ff3e4f';

// Shiller data URL (Excel file from shillerdata.com)
const SHILLER_URL = 'https://shillerdata.com/ie_data.xls';

// Cache storage
const cache = {
    creditSpread: { data: null, timestamp: 0 },
    buffett: { data: null, timestamp: 0 },
    cape: { data: null, timestamp: 0 },
    shillerData: { data: null, timestamp: 0 }
};

const CACHE_DURATION = {
    creditSpread: 60 * 60 * 1000,         // 1 hour
    buffett: 24 * 60 * 60 * 1000,         // 24 hours
    cape: 24 * 60 * 60 * 1000,            // 24 hours
    shillerData: 24 * 60 * 60 * 1000      // 24 hours
};

// Historical percentile data
const HISTORICAL = {
    creditSpread: {
        getPercentile: (value) => {
            const percentiles = [
                { value: 1.16, pct: 0 }, { value: 1.50, pct: 5 }, { value: 1.69, pct: 19 },
                { value: 1.76, pct: 25 }, { value: 2.15, pct: 50 }, { value: 2.67, pct: 75 },
                { value: 3.00, pct: 85 }, { value: 3.50, pct: 95 }, { value: 6.16, pct: 100 }
            ];
            return interpolatePercentile(value, percentiles);
        }
    },
    cape: {
        getPercentile: (value) => {
            const percentiles = [
                { value: 6.6, pct: 0 }, { value: 10.0, pct: 10 }, { value: 15.0, pct: 25 },
                { value: 20.5, pct: 50 }, { value: 25.0, pct: 75 }, { value: 30.0, pct: 90 },
                { value: 35.0, pct: 95 }, { value: 40.0, pct: 98 }, { value: 48.1, pct: 100 }
            ];
            return interpolatePercentile(value, percentiles);
        }
    },
    buffett: {
        getPercentile: (value) => {
            const percentiles = [
                { value: 35, pct: 0 }, { value: 50, pct: 15 }, { value: 70, pct: 35 },
                { value: 85, pct: 50 }, { value: 110, pct: 70 }, { value: 140, pct: 85 },
                { value: 175, pct: 93 }, { value: 200, pct: 97 }, { value: 250, pct: 100 }
            ];
            return interpolatePercentile(value, percentiles);
        }
    }
};

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

// Fetch and parse Shiller Excel data
async function fetchShillerData() {
    if (isCacheValid('shillerData')) {
        return cache.shillerData.data;
    }

    try {
        console.log('Fetching Shiller data from Yale...');
        const response = await fetch(SHILLER_URL);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; // Usually "Data"
        const sheet = workbook.Sheets[sheetName];
        
        // Convert to JSON
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        
        // Find the CAPE column and get latest value
        // Shiller's format: Date, S&P, Dividend, Earnings, CPI, Date Fraction, Long Rate, Real Price, Real Dividend, Real Earnings, CAPE
        // The header row varies, so we search for it
        
        let capeColumnIndex = -1;
        let headerRowIndex = -1;
        
        // Find header row containing "CAPE" or "P/E10" or "Cyclically Adjusted"
        for (let i = 0; i < Math.min(data.length, 20); i++) {
            const row = data[i];
            if (row) {
                for (let j = 0; j < row.length; j++) {
                    const cell = String(row[j] || '').toLowerCase();
                    if (cell.includes('cape') || cell.includes('p/e10') || cell.includes('cyclically')) {
                        capeColumnIndex = j;
                        headerRowIndex = i;
                        break;
                    }
                }
                if (capeColumnIndex >= 0) break;
            }
        }
        
        // If we couldn't find CAPE header, try column index 10 (typical position)
        if (capeColumnIndex < 0) {
            capeColumnIndex = 10;
            headerRowIndex = 7; // Typical header row
        }
        
        // Get the latest non-empty CAPE value
        let latestCape = null;
        let latestDate = null;
        
        for (let i = data.length - 1; i > headerRowIndex; i--) {
            const row = data[i];
            if (row && row[capeColumnIndex] && !isNaN(parseFloat(row[capeColumnIndex]))) {
                latestCape = parseFloat(row[capeColumnIndex]);
                latestDate = row[0]; // Date is usually first column
                break;
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
        // Return cached data if available, otherwise fallback
        if (cache.shillerData.data) {
            return cache.shillerData.data;
        }
        return { cape: 38.2, date: 'fallback', source: 'static', error: error.message };
    }
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

        const [mcResponse, gdpResponse] = await Promise.all([
            fetch(`${FRED_BASE}?series_id=BOGZ1LM883164115Q&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`),
            fetch(`${FRED_BASE}?series_id=GDP&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`)
        ]);

        const mcData = await mcResponse.json();
        const gdpData = await gdpResponse.json();

        if (mcData.observations?.length > 0 && gdpData.observations?.length > 0) {
            const marketCap = parseFloat(mcData.observations[0].value);
            const gdp = parseFloat(gdpData.observations[0].value) * 1000;
            const buffettValue = (marketCap / gdp) * 100;
            const percentile = HISTORICAL.buffett.getPercentile(buffettValue);

            const result = {
                value: Math.round(buffettValue),
                percentile: percentile,
                marketCapDate: mcData.observations[0].date,
                gdpDate: gdpData.observations[0].date,
                isAllTimeHigh: buffettValue >= 240,
                updatedAt: new Date().toISOString()
            };

            cache.buffett = { data: result, timestamp: Date.now() };
            return res.json(result);
        }

        throw new Error('No data from FRED');
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
        const percentile = HISTORICAL.cape.getPercentile(shillerData.cape);

        const result = {
            value: shillerData.cape,
            percentile: percentile,
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
        const [shillerData, creditResponse, buffettResponses, sp500Response] = await Promise.all([
            fetchShillerData(),
            fetch(`${FRED_BASE}?series_id=BAA10Y&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`).then(r => r.json()),
            Promise.all([
                fetch(`${FRED_BASE}?series_id=BOGZ1LM883164115Q&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`).then(r => r.json()),
                fetch(`${FRED_BASE}?series_id=GDP&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`).then(r => r.json())
            ]),
            fetch(`${FRED_BASE}?series_id=SP500&api_key=${FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`).then(r => r.json())
        ]);

        // Parse CAPE
        const capeValue = shillerData.cape;
        const capePercentile = HISTORICAL.cape.getPercentile(capeValue);

        // Parse Credit Spread
        const creditValue = parseFloat(creditResponse.observations[0].value);
        const creditPercentile = HISTORICAL.creditSpread.getPercentile(creditValue);

        // Parse Buffett
        const [mcData, gdpData] = buffettResponses;
        const marketCap = parseFloat(mcData.observations[0].value);
        const gdp = parseFloat(gdpData.observations[0].value) * 1000;
        const buffettValue = Math.round((marketCap / gdp) * 100);
        const buffettPercentile = HISTORICAL.buffett.getPercentile(buffettValue);

        // Composite score = average of CAPE and Buffett percentiles
        const compositeScore = Math.round((capePercentile + buffettPercentile) / 2);

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
                date: shillerData.date,
                source: 'Shiller/Yale'
            },
            buffett: {
                value: buffettValue,
                percentile: buffettPercentile,
                date: mcData.observations[0].date,
                isAllTimeHigh: buffettValue >= 240
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
            buffett: { value: 244, percentile: 100, isAllTimeHigh: true },
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
            creditSpread: isCacheValid('creditSpread') ? 'valid' : 'expired'
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
