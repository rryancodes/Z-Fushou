const { extractJSONObject } = require('../json');

describe('live JSON extraction', () => {
  it('extracts raw JSON objects', () => {
    const result = extractJSONObject('{"summary":"ok","timeline":[]}');
    expect(JSON.parse(result)).toEqual({ summary: 'ok', timeline: [] });
  });

  it('extracts fenced JSON objects', () => {
    const result = extractJSONObject('```json\n{"summary":"ok"}\n```');
    expect(JSON.parse(result).summary).toBe('ok');
  });

  it('extracts JSON surrounded by prose', () => {
    const result = extractJSONObject('Here is the update: {"summary":"done","nested":{"a":1}} thanks');
    expect(JSON.parse(result).nested.a).toBe(1);
  });

  it('returns null when no JSON object is present', () => {
    expect(extractJSONObject('plain text')).toBeNull();
  });
});
