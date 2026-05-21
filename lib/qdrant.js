const { QdrantClient } = require('@qdrant/js-client-rest');
const { embed } = require('./cloudflare');

const client = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY
});

const COLLECTIONS = {
  docs: 'docs_chunks',
  cases: 'resolved_cases',
  tribal: 'tribal_knowledge',
  community: 'community_knowledge'
};

// BGE-large-en-v1.5 outputs 1024 dimensions
const VECTOR_SIZE = 1024;

async function ensureCollection(name, silent = false) {
  try {
    await client.getCollection(name);
    if (!silent) console.log(`[qdrant] Collection "${name}" already exists`);
  } catch {
    await client.createCollection(name, {
      vectors: {
        size: VECTOR_SIZE,
        distance: 'Cosine'
      }
    });
    if (!silent) console.log(`[qdrant] Collection "${name}" created`);
  }
}

// Delete and recreate collection with correct vector size
async function resetCollection(name, silent = false) {
  try {
    await client.deleteCollection(name);
    if (!silent) console.log(`[qdrant] Collection "${name}" deleted`);
  } catch (err) {
    if (!silent) console.log(`[qdrant] Collection "${name}" did not exist`);
  }
  await ensureCollection(name, silent);
}

async function upsert(collectionName, points) {
  await client.upsert(collectionName, {
    wait: true,
    points
  });
}

async function search(collectionName, vector, limit = 5, filter = null) {
  const params = { vector, limit, with_payload: true };
  if (filter) params.filter = filter;
  const results = await client.search(collectionName, params);
  return results;
}

async function initCollections() {
  for (const name of Object.values(COLLECTIONS)) {
    await ensureCollection(name);
  }
}

// ── High-level search helpers used by agent.js ────────────────────────────────
// These embed the query text and search the relevant collections.
// agent.js imports these as { searchDocs, searchCases }.

/**
 * Search docs_chunks + tribal_knowledge + community_knowledge for a query string.
 * Returns up to `limit` results merged and sorted by score descending.
 */
async function searchDocs(queryText, limit = 10) {
  const vector = await embed(queryText);

  // Search all three knowledge collections in parallel
  const [docs, tribal, community] = await Promise.all([
    search(COLLECTIONS.docs, vector, limit).catch(err => {
      console.error('[qdrant] searchDocs docs error:', err.message);
      return [];
    }),
    search(COLLECTIONS.tribal, vector, limit).catch(err => {
      console.error('[qdrant] searchDocs tribal error:', err.message);
      return [];
    }),
    search(COLLECTIONS.community, vector, limit).catch(err => {
      console.error('[qdrant] searchDocs community error:', err.message);
      return [];
    }),
  ]);

  // Merge, normalise shape, sort by score descending, return top `limit`
  const merged = [...docs, ...tribal, ...community]
    .map(r => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  console.log(`[qdrant] searchDocs: ${merged.length} results (best: ${merged[0]?.score?.toFixed(3) ?? 0})`);
  return merged;
}

/**
 * Search resolved_cases for a query string.
 * Returns up to `limit` results.
 */
async function searchCases(queryText, limit = 5) {
  const vector = await embed(queryText);

  const results = await search(COLLECTIONS.cases, vector, limit).catch(err => {
    console.error('[qdrant] searchCases error:', err.message);
    return [];
  });

  const normalised = results.map(r => ({
    id: r.id,
    score: r.score,
    payload: r.payload,
  }));

  console.log(`[qdrant] searchCases: ${normalised.length} results (best: ${normalised[0]?.score?.toFixed(3) ?? 0})`);
  return normalised;
}

module.exports = {
  client,
  COLLECTIONS,
  VECTOR_SIZE,
  ensureCollection,
  resetCollection,
  upsert,
  search,
  initCollections,
  searchDocs,
  searchCases,
};