const supabase = require('./supabase');

// Cache departments in memory so we're not hitting DB on every message
let cached = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getDepartments() {
  const now = Date.now();
  if (cached && now - cacheTime < CACHE_TTL) return cached;

  const { data, error } = await supabase
    .from('departments')
    .select('*');

  if (error) {
    console.error('Failed to load departments:', error.message);
    return [];
  }

  cached = data;
  cacheTime = now;
  return data;
}

async function detectDepartment(text) {
  const departments = await getDepartments();
  const lower = text.toLowerCase();

  // Score each department by how many keywords match
  let bestMatch = 'unclassified';
  let bestScore = 0;

  for (const dept of departments) {
    if (!dept.keywords || dept.keywords.length === 0) continue;
    const score = dept.keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = dept.name;
    }
  }

  return bestMatch;
}

module.exports = { getDepartments, detectDepartment };
