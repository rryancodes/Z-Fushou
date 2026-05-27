const {
  extractJSON,
  stripMarkdownFences,
  findBalancedJSON,
  callLLMForSummary,
  summarizeTopic,
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

  // --- CF Workers AI object content regression ---

  it('handles JSON.stringified object content (CF Workers AI regression)', () => {
    // CF Workers AI returns parsed objects, not strings. After our fix in callLLMForSummary,
    // these get JSON.stringify'd before reaching extractJSON.
    const obj = { summary: 'test', key_issues: ['a'], unanswered_questions: [], sentiment: 'frustrated', severity: 'high' };
    const input = JSON.stringify(obj);
    const result = extractJSON(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result);
    expect(parsed.summary).toBe('test');
    expect(parsed.sentiment).toBe('frustrated');
    expect(parsed.severity).toBe('high');
    expect(parsed.key_issues).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// callLLMForSummary — object content normalization
// ---------------------------------------------------------------------------
describe('callLLMForSummary', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('normalizes object content from CF Workers AI to string', async () => {
    // Simulate CF Workers AI returning parsed JSON in content field
    const responseObject = {
      summary: 'Users report login failures',
      key_issues: ['Authentication timeout', 'Session expiry'],
      unanswered_questions: ['When will this be fixed?'],
      sentiment: 'frustrated',
      severity: 'high',
    };

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseObject } }],
        usage: { total_tokens: 150 },
      }),
      text: async () => JSON.stringify({}),
    });

    const result = await callLLMForSummary('system prompt', 'user content');

    // Content should be a string after normalization
    expect(typeof result.content).toBe('string');
    // Should be parseable JSON
    const parsed = JSON.parse(result.content);
    expect(parsed.summary).toBe('Users report login failures');
    expect(parsed.sentiment).toBe('frustrated');
    expect(parsed.key_issues).toHaveLength(2);
  });

  it('preserves string content from LLM responses', async () => {
    const responseString = '{"summary":"test","key_issues":[],"unanswered_questions":[],"sentiment":"neutral","severity":"medium"}';

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseString } }],
        usage: { total_tokens: 50 },
      }),
      text: async () => JSON.stringify({}),
    });

    const result = await callLLMForSummary('system prompt', 'user content');
    expect(typeof result.content).toBe('string');
    expect(result.content).toBe(responseString);
  });
});

// ---------------------------------------------------------------------------
// summarizeTopic — no silent fallback
// ---------------------------------------------------------------------------
describe('summarizeTopic', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws on LLM failure instead of returning neutral/medium fallback', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      ok: false,
      text: async () => 'Internal Server Error',
      json: async () => ({}),
    });

    const segments = [{
      segmentIndex: 0,
      startTimestamp: '2026-05-25T10:00:00Z',
      endTimestamp: '2026-05-25T11:00:00Z',
      messages: [
        { username: 'user1', content: 'test message', timestamp: '2026-05-25T10:30:00Z', user_id: 'u1', message_id: 'm1' },
      ],
    }];

    await expect(summarizeTopic('Test Topic', segments)).rejects.toThrow();
  });

  it('returns real sentiment and severity from object content', async () => {
    // Simulate CF Workers AI returning a parsed JSON object
    const responseObject = {
      summary: 'Users are experiencing critical API failures',
      key_issues: ['API returning 500 errors', 'Users cannot access their accounts'],
      unanswered_questions: ['What is the ETA for the fix?'],
      sentiment: 'frustrated',
      severity: 'critical',
    };

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseObject } }],
        usage: { total_tokens: 200 },
      }),
      text: async () => JSON.stringify({}),
    });

    const segments = [{
      segmentIndex: 0,
      startTimestamp: '2026-05-25T10:00:00Z',
      endTimestamp: '2026-05-25T11:00:00Z',
      messages: [
        { username: 'user1', content: 'API is down!', timestamp: '2026-05-25T10:30:00Z', user_id: 'u1', message_id: 'm1' },
      ],
    }];

    const result = await summarizeTopic('API Outage', segments);

    // Must NOT be the default neutral/medium
    expect(result.sentiment).toBe('frustrated');
    expect(result.severity).toBe('critical');
    expect(result.key_issues).toHaveLength(2);
    expect(result.key_issues[0]).toContain('500');
    expect(result.unanswered_questions).toHaveLength(1);
    expect(result.tokensUsed).toBe(200);
  });

  it('returns real key_issues and unanswered_questions (not empty)', async () => {
    const responseObject = {
      summary: 'Mixed discussion about new features',
      key_issues: ['Feature request for dark mode', 'Bug in search functionality'],
      unanswered_questions: ['When will dark mode be available?', 'Is the search bug being tracked?'],
      sentiment: 'confused',
      severity: 'medium',
    };

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseObject } }],
        usage: { total_tokens: 150 },
      }),
      text: async () => JSON.stringify({}),
    });

    const segments = [{
      segmentIndex: 0,
      startTimestamp: '2026-05-25T10:00:00Z',
      endTimestamp: '2026-05-25T11:00:00Z',
      messages: [
        { username: 'user1', content: 'any dark mode?', timestamp: '2026-05-25T10:30:00Z', user_id: 'u1', message_id: 'm1' },
      ],
    }];

    const result = await summarizeTopic('Feature Request', segments);

    expect(result.key_issues).toHaveLength(2);
    expect(result.unanswered_questions).toHaveLength(2);
    expect(result.sentiment).toBe('confused');
  });
});
