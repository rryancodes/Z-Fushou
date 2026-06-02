function isNormalized(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return false;
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return Math.abs(mag - 1.0) < 0.01;
}

function normalize(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return [];
  const mag = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (mag === 0) return new Array(vec.length).fill(0);
  return vec.map((value) => value / mag);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function averageVectors(vectors) {
  const valid = vectors.filter((vec) => Array.isArray(vec) && vec.length > 0);
  if (valid.length === 0) return [];

  const dim = valid[0].length;
  const avg = new Array(dim).fill(0);
  for (const vec of valid) {
    for (let i = 0; i < dim; i++) {
      avg[i] += vec[i];
    }
  }

  return normalize(avg.map((value) => value / valid.length));
}

function updateCentroid(currentCentroid, newVector, currentCount) {
  if (!Array.isArray(currentCentroid) || currentCentroid.length === 0 || currentCount <= 0) {
    return normalize(newVector);
  }

  const dim = currentCentroid.length;
  const next = new Array(dim);
  for (let i = 0; i < dim; i++) {
    next[i] = ((currentCentroid[i] * currentCount) + newVector[i]) / (currentCount + 1);
  }

  return normalize(next);
}

module.exports = {
  isNormalized,
  normalize,
  cosineSimilarity,
  averageVectors,
  updateCentroid,
};
