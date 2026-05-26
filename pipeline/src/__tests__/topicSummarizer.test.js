const {
  extractJSON,
  stripMarkdownFences,
  findBalancedJSON,
} = require('../topicSummarizer');

// ---------------------------------------------------------------------------
// stripMarkdownFences
// ---------------------------------------------------------------------------
describe('stripMarkdownFences', () => {
  it('strips ```json fences', () => {
    const input = '```json\n{"a":1}\n```';
    expect(stripMarkdownFences(input)).toBe('{"a":1}');
  });

  it('strips uppercase ```JSON fences', () => {
    const input = '```JSON\n{"a":1}\n```';
    expect(stripMarkdownFences(input)).toBe('{"a":1}');
  });

  it('strips bare ``` fences', () => {
    const input = '```\n{"a":1}\n```';
    expect(stripMarkdownFences(input)).toBe('{"a":1}');
  });

  it('handles fences without newline after opening', () => {
    const input = '```json{"a":1}```';
    expect(stripMarkdownFences(input)).toBe('{"a":1}');
  });

  it('leaves plain JSON untouched', () => {
    const input = '{"a":1}';
    expect(stripMarkdownFences(input)).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// findBalancedJSON
// ---------------------------------------------------------------------------
describe('findBalancedJSON', () => {
  it('finds a simple JSON object', () => {
    const result = findBalancedJSON('here is {"a":1} ok');
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it('finds nested objects', () => {
    const result = findBalancedJSON('prefix {"a":{"b":2}} suffix');
    expect(JSON.parse(result)).toEqual({ a: { b: 2 } });
  });

  it('skips incomplete braces', () => {
    expect(findBalancedJSON('no braces here')).toBeNull();
  });

  it('handles braces inside strings', () => {
    const result = findBalancedJSON('{"a":"{not an object}"}');
    expect(JSON.parse(result)).toEqual({ a: '{not an object}' });
  });

  it('returns null on malformed JSON', () => {
    expect(findBalancedJSON('{invalid json}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractJSON — the main function under test
// ---------------------------------------------------------------------------
describe('extractJSON', () => {
  // --- Valid inputs that should succeed ---

  it('extracts raw JSON', () => {
    const input = '{"summary":"hello","key_issues":[],"unanswered_questions":[]}';
    const result = extractJSON(input);
    expect(JSON.parse(result)).toEqual({
      summary: 'hello',
      key_issues: [],
      unanswered_questions: [],
    });
  });

  it('extracts JSON from ```json fence', () => {
    const input = '```json\n{"summary":"hello","key_issues":[],"unanswered_questions":[]}\n```';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('hello');
  });

  it('extracts JSON from ``` fence (no language tag)', () => {
    const input = '```\n{"summary":"hello","key_issues":[],"unanswered_questions":[]}\n```';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('hello');
  });

  it('extracts JSON surrounded by prose', () => {
    const input = 'Here is the summary:\n{"summary":"hello","key_issues":["a"],"unanswered_questions":[]}\nThat covers it.';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('hello');
  });

  it('extracts JSON with fence and prose', () => {
    const input = 'Sure! Here is the JSON:\n```json\n{"summary":"test","key_issues":[],"unanswered_questions":[]}\n```\nLet me know if you need more.';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('test');
  });

  it('extracts JSON when opening fence has no newline', () => {
    const input = '```json{"summary":"no newline","key_issues":[],"unanswered_questions":[]}```';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('no newline');
  });

  it('handles ```JSON (uppercase)', () => {
    const input = '```JSON\n{"summary":"upper","key_issues":[],"unanswered_questions":[]}\n```';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('upper');
  });

  it('extracts JSON with nested objects and arrays', () => {
    const input = '```json\n{"summary":"complex","key_issues":["a","b"],"unanswered_questions":["q1"],"nested":{"x":[1,2]}}\n```';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result);
    expect(parsed.nested.x).toEqual([1, 2]);
  });

  // --- Invalid inputs that should return null ---

  it('returns null for null input', () => {
    expect(extractJSON(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractJSON(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJSON('')).toBeNull();
  });

  it('returns null for pure prose with no JSON', () => {
    expect(extractJSON('This is just plain text with no JSON object at all.')).toBeNull();
  });

  it('returns null for prose with backticks but no JSON', () => {
    expect(extractJSON('```json\nThis is not JSON\n```')).toBeNull();
  });

  it('returns null for incomplete JSON', () => {
    expect(extractJSON('{"summary":"broken"')).toBeNull();
  });

  // --- Edge cases from the May 25 failures ---

  it('handles fenced JSON where fence regex might fail (no closing fence)', () => {
    // No closing ```, but JSON is complete — should still extract
    const input = '```json\n{"summary":"open fence","key_issues":[],"unanswered_questions":[]}';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result).summary).toBe('open fence');
  });

  it('never returns text with backticks', () => {
    const input = '```json\n{"summary":"test","key_issues":[],"unanswered_questions":[]}\n```';
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    expect(result).not.toContain('`');
  });

  it('handles double-fenced output', () => {
    const input = '````json\n{"summary":"double","key_issues":[],"unanswered_questions":[]}\n````';
    const result = extractJSON(input);
    // May or may not parse the code block, but should not return raw text with backticks
    if (result !== null) {
      expect(result).not.toContain('`');
    }
  });
});
