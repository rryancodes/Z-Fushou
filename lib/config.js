const supabase = require('./supabase');

let cache = null;
let cacheTime = 0;
const TTL = 2 * 60 * 1000;

async function getConfig() {
  const now = Date.now();
  if (cache && now - cacheTime < TTL) return cache;

  const { data, error } = await supabase
    .from('bot_config')
    .select('key, value');

  if (error) {
    console.error('Failed to load bot_config:', error.message);
    return cache || {};
  }

  cache = Object.fromEntries(data.map(row => [row.key, row.value]));
  cacheTime = now;
  return cache;
}

async function get(key, fallback = null) {
  const config = await getConfig();
  const val = config[key];
  // Treat empty string same as missing — fall through to fallback
  if (val === undefined || val === null || val === '') return fallback;
  return val;
}

async function getBoolean(key, fallback = true) {
  const val = await get(key, String(fallback));
  return val === 'true';
}

module.exports = { get, getBoolean, getConfig };
