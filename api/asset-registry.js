/* eslint-disable */
// V12 — api/asset-registry.js
//
// The curated catalog of every asset Quantum Bot knows about.
//
// Each asset has a stable `id` (lowercase, no special chars) used everywhere internally.
// Each asset has many `aliases` — the various symbol strings different brokers use.
// When a user connects MetaAPI, we fetch their broker's symbol list and try to match
// each available symbol against every asset's alias list. Successful matches build the
// per-user symbol map (lives in symbol-resolver.js).
//
// Adding a new asset = add an entry here. That's the only file that needs editing.
// ----------------------------------------------------------------------------

const ASSETS = [
  // ===================================================================
  // FOREX MAJORS
  // ===================================================================
  {
    id: 'eurusd',
    name: 'EUR/USD',
    category: 'forex',
    description: 'Euro vs US Dollar',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 10,
    typicalSpreadPips: 0.8,
    typicalH1ATR: 0.0008,
    preferredSessions: ['LONDON', 'OVERLAP', 'NEW_YORK'],
    aliases: [
      'EURUSD', 'EUR/USD', 'EURUSD.s', 'EURUSD.r', 'EURUSDm', 'EURUSD#',
      'EURUSD.std', 'EURUSD.pro', 'EURUSD-PRO', 'EURUSD.raw', 'EURUSD-RAW',
      'EURUSDc', 'EURUSDi', 'EURUSDecn',
    ],
  },
  {
    id: 'gbpusd',
    name: 'GBP/USD',
    category: 'forex',
    description: 'British Pound vs US Dollar',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 10,
    typicalSpreadPips: 1.2,
    typicalH1ATR: 0.0011,
    preferredSessions: ['LONDON', 'OVERLAP', 'NEW_YORK'],
    aliases: [
      'GBPUSD', 'GBP/USD', 'GBPUSD.s', 'GBPUSD.r', 'GBPUSDm', 'GBPUSD#',
      'GBPUSD.std', 'GBPUSD.pro', 'GBPUSD-PRO', 'GBPUSD.raw',
      'GBPUSDc', 'GBPUSDi',
    ],
  },
  {
    id: 'usdjpy',
    name: 'USD/JPY',
    category: 'forex',
    description: 'US Dollar vs Japanese Yen',
    pipSize: 0.01,
    contractSize: 100000,
    dollarPerPipPerLot: 6.7, // approx, varies with USD/JPY rate
    typicalSpreadPips: 0.9,
    typicalH1ATR: 0.08,
    preferredSessions: ['ASIAN', 'LONDON', 'NEW_YORK'],
    aliases: [
      'USDJPY', 'USD/JPY', 'USDJPY.s', 'USDJPY.r', 'USDJPYm', 'USDJPY#',
      'USDJPY.std', 'USDJPY.pro', 'USDJPY.raw',
    ],
  },
  {
    id: 'usdchf',
    name: 'USD/CHF',
    category: 'forex',
    description: 'US Dollar vs Swiss Franc',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 11,
    typicalSpreadPips: 1.5,
    typicalH1ATR: 0.0008,
    preferredSessions: ['LONDON', 'NEW_YORK'],
    aliases: [
      'USDCHF', 'USD/CHF', 'USDCHF.s', 'USDCHF.r', 'USDCHFm', 'USDCHF#',
      'USDCHF.std', 'USDCHF.pro',
    ],
  },
  {
    id: 'audusd',
    name: 'AUD/USD',
    category: 'forex',
    description: 'Australian Dollar vs US Dollar',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 10,
    typicalSpreadPips: 1.0,
    typicalH1ATR: 0.0007,
    preferredSessions: ['ASIAN', 'LONDON'],
    aliases: [
      'AUDUSD', 'AUD/USD', 'AUDUSD.s', 'AUDUSD.r', 'AUDUSDm', 'AUDUSD#',
      'AUDUSD.std', 'AUDUSD.pro',
    ],
  },
  {
    id: 'nzdusd',
    name: 'NZD/USD',
    category: 'forex',
    description: 'New Zealand Dollar vs US Dollar',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 10,
    typicalSpreadPips: 1.5,
    typicalH1ATR: 0.0007,
    preferredSessions: ['ASIAN', 'LONDON'],
    aliases: [
      'NZDUSD', 'NZD/USD', 'NZDUSD.s', 'NZDUSD.r', 'NZDUSDm', 'NZDUSD#',
      'NZDUSD.std', 'NZDUSD.pro',
    ],
  },
  {
    id: 'usdcad',
    name: 'USD/CAD',
    category: 'forex',
    description: 'US Dollar vs Canadian Dollar',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 7.5,
    typicalSpreadPips: 1.5,
    typicalH1ATR: 0.0008,
    preferredSessions: ['NEW_YORK'],
    aliases: [
      'USDCAD', 'USD/CAD', 'USDCAD.s', 'USDCAD.r', 'USDCADm', 'USDCAD#',
      'USDCAD.std', 'USDCAD.pro',
    ],
  },

  // ===================================================================
  // FOREX CROSSES
  // ===================================================================
  {
    id: 'eurjpy',
    name: 'EUR/JPY',
    category: 'forex',
    description: 'Euro vs Japanese Yen',
    pipSize: 0.01,
    contractSize: 100000,
    dollarPerPipPerLot: 6.7,
    typicalSpreadPips: 1.5,
    typicalH1ATR: 0.10,
    preferredSessions: ['ASIAN', 'LONDON'],
    aliases: ['EURJPY', 'EUR/JPY', 'EURJPY.s', 'EURJPYm', 'EURJPY#', 'EURJPY.pro', 'EURJPY.raw'],
  },
  {
    id: 'gbpjpy',
    name: 'GBP/JPY',
    category: 'forex',
    description: 'British Pound vs Japanese Yen — high volatility',
    pipSize: 0.01,
    contractSize: 100000,
    dollarPerPipPerLot: 6.7,
    typicalSpreadPips: 2.0,
    typicalH1ATR: 0.13,
    preferredSessions: ['ASIAN', 'LONDON'],
    aliases: ['GBPJPY', 'GBP/JPY', 'GBPJPY.s', 'GBPJPYm', 'GBPJPY#', 'GBPJPY.pro'],
  },
  {
    id: 'eurgbp',
    name: 'EUR/GBP',
    category: 'forex',
    description: 'Euro vs British Pound',
    pipSize: 0.0001,
    contractSize: 100000,
    dollarPerPipPerLot: 13,
    typicalSpreadPips: 1.5,
    typicalH1ATR: 0.0006,
    preferredSessions: ['LONDON'],
    aliases: ['EURGBP', 'EUR/GBP', 'EURGBP.s', 'EURGBPm', 'EURGBP#', 'EURGBP.pro'],
  },
  {
    id: 'audjpy',
    name: 'AUD/JPY',
    category: 'forex',
    description: 'Australian Dollar vs Japanese Yen',
    pipSize: 0.01,
    contractSize: 100000,
    dollarPerPipPerLot: 6.7,
    typicalSpreadPips: 1.8,
    typicalH1ATR: 0.08,
    preferredSessions: ['ASIAN', 'LONDON'],
    aliases: ['AUDJPY', 'AUD/JPY', 'AUDJPY.s', 'AUDJPYm', 'AUDJPY#'],
  },

  // ===================================================================
  // METALS
  // ===================================================================
  {
    id: 'gold',
    name: 'Gold',
    category: 'metal',
    description: 'Spot Gold (XAU/USD) — high volatility, news-sensitive',
    pipSize: 0.01,
    contractSize: 100,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 30,
    typicalH1ATR: 4,
    preferredSessions: ['LONDON', 'OVERLAP', 'NEW_YORK'],
    aliases: [
      'XAUUSD', 'XAU/USD', 'XAUUSD.s', 'XAUUSD.r', 'XAUUSDm', 'XAUUSD#',
      'XAUUSD.std', 'XAUUSD.pro', 'XAUUSD-PRO', 'XAUUSD.raw',
      'GOLD', 'GOLD.cash', 'GOLD#', 'GOLDm', 'GOLD.s',
    ],
  },
  {
    id: 'silver',
    name: 'Silver',
    category: 'metal',
    description: 'Spot Silver (XAG/USD)',
    pipSize: 0.01,
    contractSize: 5000,
    dollarPerPipPerLot: 5,
    typicalSpreadPips: 3,
    typicalH1ATR: 0.6,
    preferredSessions: ['LONDON', 'NEW_YORK'],
    aliases: [
      'XAGUSD', 'XAG/USD', 'XAGUSD.s', 'XAGUSDm', 'XAGUSD#',
      'SILVER', 'SILVER.cash', 'SILVER#', 'SILVERm',
    ],
  },
  {
    id: 'platinum',
    name: 'Platinum',
    category: 'metal',
    description: 'Spot Platinum (XPT/USD)',
    pipSize: 0.01,
    contractSize: 100,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 100,
    typicalH1ATR: 8,
    preferredSessions: ['NEW_YORK'],
    aliases: ['XPTUSD', 'XPT/USD', 'XPTUSD.s', 'XPTUSDm', 'PLATINUM', 'PLATINUM#'],
  },

  // ===================================================================
  // CRYPTO
  // ===================================================================
  {
    id: 'btc',
    name: 'Bitcoin',
    category: 'crypto',
    description: 'Bitcoin vs USD — trades 24/7 including weekends',
    pipSize: 1.0,
    contractSize: 1,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 30,
    typicalH1ATR: 200,
    preferredSessions: ['ASIAN', 'LONDON', 'OVERLAP', 'NEW_YORK'], // 24/7
    tradesWeekends: true,
    aliases: [
      'BTCUSD', 'BTC/USD', 'BTCUSDT', 'BTC/USDT', 'BTCUSD.s', 'BTCUSD.r',
      'BTCUSDm', 'BTCUSD#', 'BTCUSD.std', 'BTCUSD.pro', 'BTCUSD.raw',
      'BTC', 'BITCOIN', 'BITCOIN#', 'XBTUSD', 'XBT/USD',
    ],
  },
  {
    id: 'eth',
    name: 'Ethereum',
    category: 'crypto',
    description: 'Ethereum vs USD — trades 24/7',
    pipSize: 0.01,
    contractSize: 1,
    dollarPerPipPerLot: 0.01,
    typicalSpreadPips: 200, // in 0.01 units
    typicalH1ATR: 15,
    preferredSessions: ['ASIAN', 'LONDON', 'OVERLAP', 'NEW_YORK'],
    tradesWeekends: true,
    aliases: [
      'ETHUSD', 'ETH/USD', 'ETHUSDT', 'ETH/USDT', 'ETHUSD.s', 'ETHUSDm',
      'ETHUSD#', 'ETH', 'ETHEREUM', 'ETHEREUM#',
    ],
  },
  {
    id: 'sol',
    name: 'Solana',
    category: 'crypto',
    description: 'Solana vs USD',
    pipSize: 0.01,
    contractSize: 1,
    dollarPerPipPerLot: 0.01,
    typicalSpreadPips: 50,
    typicalH1ATR: 1.2,
    preferredSessions: ['ASIAN', 'LONDON', 'OVERLAP', 'NEW_YORK'],
    tradesWeekends: true,
    aliases: ['SOLUSD', 'SOL/USD', 'SOLUSDT', 'SOL/USDT', 'SOLUSDm', 'SOL', 'SOLANA'],
  },
  {
    id: 'xrp',
    name: 'Ripple',
    category: 'crypto',
    description: 'Ripple vs USD',
    pipSize: 0.0001,
    contractSize: 1,
    dollarPerPipPerLot: 0.0001,
    typicalSpreadPips: 50,
    typicalH1ATR: 0.02,
    preferredSessions: ['ASIAN', 'LONDON', 'OVERLAP', 'NEW_YORK'],
    tradesWeekends: true,
    aliases: ['XRPUSD', 'XRP/USD', 'XRPUSDT', 'XRP/USDT', 'XRPUSDm', 'XRP', 'RIPPLE'],
  },

  // ===================================================================
  // INDICES
  // ===================================================================
  {
    id: 'nas100',
    name: 'Nasdaq 100',
    category: 'index',
    description: 'US tech-heavy index futures',
    pipSize: 1.0,
    contractSize: 1,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 1.5,
    typicalH1ATR: 60,
    preferredSessions: ['NEW_YORK', 'OVERLAP'],
    aliases: [
      'NAS100', 'NDX100', 'NDXUSD', 'NDX', 'USTEC', 'USTEC.cash',
      'NAS100.s', 'NAS100m', 'NAS100#', 'NAS100.cash', 'US100',
      'USTECH100', 'NASDAQ', 'NASDAQ100',
    ],
  },
  {
    id: 'us30',
    name: 'Dow Jones',
    category: 'index',
    description: 'Dow Jones Industrial Average futures',
    pipSize: 1.0,
    contractSize: 1,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 2,
    typicalH1ATR: 80,
    preferredSessions: ['NEW_YORK', 'OVERLAP'],
    aliases: [
      'US30', 'US30.cash', 'US30m', 'US30#', 'US30.s',
      'DJ30', 'DJ30.s', 'DJI', 'DOWJONES', 'WALL30', 'DOW',
    ],
  },
  {
    id: 'us500',
    name: 'S&P 500',
    category: 'index',
    description: 'S&P 500 futures',
    pipSize: 0.1,
    contractSize: 1,
    dollarPerPipPerLot: 0.1,
    typicalSpreadPips: 5,
    typicalH1ATR: 8,
    preferredSessions: ['NEW_YORK', 'OVERLAP'],
    aliases: [
      'US500', 'US500.cash', 'US500m', 'US500#', 'US500.s',
      'SPX500', 'SP500', 'SP500.s', 'SPX', 'SPY',
    ],
  },
  {
    id: 'ger40',
    name: 'DAX 40',
    category: 'index',
    description: 'German DAX 40 futures',
    pipSize: 0.1,
    contractSize: 1,
    dollarPerPipPerLot: 0.1,
    typicalSpreadPips: 10,
    typicalH1ATR: 30,
    preferredSessions: ['LONDON', 'OVERLAP'],
    aliases: [
      'GER40', 'DE40', 'DAX', 'DAX40', 'DE40.cash', 'GER40.cash',
      'GER40m', 'GER30', 'DE30',
    ],
  },
  {
    id: 'uk100',
    name: 'FTSE 100',
    category: 'index',
    description: 'UK FTSE 100 futures',
    pipSize: 0.1,
    contractSize: 1,
    dollarPerPipPerLot: 0.1,
    typicalSpreadPips: 8,
    typicalH1ATR: 25,
    preferredSessions: ['LONDON'],
    aliases: ['UK100', 'UK100.cash', 'UK100m', 'FTSE', 'FTSE100', 'GBR100'],
  },
  {
    id: 'jp225',
    name: 'Nikkei 225',
    category: 'index',
    description: 'Japan Nikkei 225 futures',
    pipSize: 1.0,
    contractSize: 1,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 8,
    typicalH1ATR: 100,
    preferredSessions: ['ASIAN'],
    aliases: ['JP225', 'JP225.cash', 'JP225m', 'NIKKEI', 'NIKKEI225', 'NIKKEI225.S', 'JPN225', 'N225'],
  },

  // ===================================================================
  // COMMODITIES
  // ===================================================================
  {
    id: 'oil_wti',
    name: 'WTI Crude Oil',
    category: 'commodity',
    description: 'West Texas Intermediate crude oil',
    pipSize: 0.01,
    contractSize: 100,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 3,
    typicalH1ATR: 0.5,
    preferredSessions: ['LONDON', 'NEW_YORK'],
    aliases: ['XTIUSD', 'USOUSD', 'USOUSD.s', 'WTI', 'WTI.cash', 'USOIL', 'USOIL.cash', 'CL', 'CL-OIL.s', 'CLUSD', 'OIL', 'CRUDE'],
  },
  {
    id: 'oil_brent',
    name: 'Brent Crude Oil',
    category: 'commodity',
    description: 'Brent crude oil',
    pipSize: 0.01,
    contractSize: 100,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 3,
    typicalH1ATR: 0.5,
    preferredSessions: ['LONDON', 'NEW_YORK'],
    aliases: ['XBRUSD', 'UKOUSD', 'UKOUSD.s', 'BRENT', 'BRENT.cash', 'UKOIL', 'UKOIL.cash', 'BRN'],
  },
  {
    id: 'natgas',
    name: 'Natural Gas',
    category: 'commodity',
    description: 'Natural gas futures',
    pipSize: 0.001,
    contractSize: 1000,
    dollarPerPipPerLot: 1,
    typicalSpreadPips: 5,
    typicalH1ATR: 0.05,
    preferredSessions: ['NEW_YORK'],
    aliases: ['XNGUSD', 'NATGAS', 'NATGAS.cash', 'NGAS', 'NG', 'NGUSD'],
  },
];

// =================================================================
// LOOKUP HELPERS
// =================================================================

// Build lookup maps once at module load
const BY_ID = {};
const BY_ALIAS = {};
const BY_CATEGORY = {};

for (const asset of ASSETS) {
  BY_ID[asset.id] = asset;
  if (!BY_CATEGORY[asset.category]) BY_CATEGORY[asset.category] = [];
  BY_CATEGORY[asset.category].push(asset);
  // Build alias map (case-insensitive, normalized)
  for (const alias of asset.aliases) {
    const norm = normalizeSymbol(alias);
    if (BY_ALIAS[norm]) {
      // Two assets claim the same alias — log warning
      console.warn(`[asset-registry] Alias collision: "${alias}" claimed by both ${BY_ALIAS[norm].id} and ${asset.id}. First wins.`);
    } else {
      BY_ALIAS[norm] = asset;
    }
  }
}

// Normalize a symbol string for alias matching: uppercase, strip non-alphanumeric except dot/hash/dash
function normalizeSymbol(s) {
  if (!s || typeof s !== 'string') return '';
  return s.toUpperCase().trim();
}

// Get an asset by its stable id (e.g., "gold", "btc")
function getAssetById(id) {
  return BY_ID[String(id).toLowerCase()] || null;
}

// Get an asset by ANY of its broker symbol aliases (e.g., "XAUUSD.s" → gold asset)
function getAssetBySymbol(brokerSymbol) {
  const norm = normalizeSymbol(brokerSymbol);
  return BY_ALIAS[norm] || null;
}

// Get all assets in a category ('forex', 'metal', 'crypto', 'index', 'commodity')
function getAssetsByCategory(category) {
  return BY_CATEGORY[category] || [];
}

// Get all asset IDs
function getAllAssetIds() {
  return Object.keys(BY_ID);
}

// Get all assets (for the Add Instrument modal)
function getAllAssets() {
  return [...ASSETS];
}

// Try to match a broker symbol to an asset, with fuzzy fallback if exact alias miss.
// Returns { asset, matchType: 'exact'|'fuzzy'|null, confidence: 0-1 }
function matchBrokerSymbol(brokerSymbol) {
  const norm = normalizeSymbol(brokerSymbol);
  if (!norm) return { asset: null, matchType: null, confidence: 0 };

  // Try exact alias match first
  const exact = BY_ALIAS[norm];
  if (exact) return { asset: exact, matchType: 'exact', confidence: 1.0 };

  // Fuzzy: strip common broker suffixes and retry
  const suffixesToTry = ['.S', '.R', '.PRO', '.STD', '.RAW', '.CASH', '.ECN', '#', 'M', 'C', 'I', '-PRO', '-RAW'];
  for (const suffix of suffixesToTry) {
    if (norm.endsWith(suffix)) {
      const stripped = norm.slice(0, -suffix.length);
      if (BY_ALIAS[stripped]) {
        return { asset: BY_ALIAS[stripped], matchType: 'fuzzy', confidence: 0.85 };
      }
    }
  }

  // Fuzzy: substring match — does any alias appear as a prefix of the broker symbol?
  // e.g., broker has "EURUSDXYZ" → match "EURUSD" prefix
  for (const alias of Object.keys(BY_ALIAS)) {
    if (alias.length >= 6 && norm.startsWith(alias)) {
      return { asset: BY_ALIAS[alias], matchType: 'fuzzy', confidence: 0.7 };
    }
  }

  return { asset: null, matchType: null, confidence: 0 };
}

// =================================================================
// EXPORTS
// =================================================================

module.exports = {
  ASSETS,
  getAssetById,
  getAssetBySymbol,
  getAssetsByCategory,
  getAllAssetIds,
  getAllAssets,
  matchBrokerSymbol,
  normalizeSymbol,
};