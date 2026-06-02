function stripMarkdownFences(text) {
  return String(text || '')
    .replace(/```(?:json|JSON)?\s*\n?/g, '')
    .replace(/\n?```\s*/g, '')
    .trim();
}

function findBalancedObject(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') depth--;

      if (depth === 0) {
        const candidate = text.slice(i, j + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

function extractJSONObject(text) {
  if (!text || typeof text !== 'string') return null;

  const fenced = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    const candidate = fenced[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Continue to balanced extraction.
    }
  }

  return findBalancedObject(stripMarkdownFences(text)) || findBalancedObject(text);
}

module.exports = { stripMarkdownFences, findBalancedObject, extractJSONObject };
