const { LiveEngine } = require('../engine');
const { LiveStateStore } = require('../state');

function createStorage() {
  return {
    cases: [],
    messages: [],
    events: [],
    processed: [],
    async fetchOpenCases() {
      return this.cases.filter((row) => row.status === 'open');
    },
    async getCaseById(caseId) {
      return this.cases.find((row) => row.id === caseId) || null;
    },
    async findCaseByMessageId(messageId) {
      const link = this.messages.find((row) => row.message_id === messageId);
      if (!link) return null;
      return this.getCaseById(link.case_id);
    },
    async fetchCaseMessages(caseId) {
      const ids = this.messages.filter((row) => row.case_id === caseId).map((row) => row.message_id);
      return this.cleanRows.filter((row) => ids.includes(row.message_id));
    },
    async findOpenCase(message) {
      return this.cases.find((row) =>
        row.status === 'open' &&
        row.guild_id === message.guild_id &&
        row.channel_id === message.channel_id &&
        row.thread_id === message.thread_id
      ) || null;
    },
    async createCase(message) {
      const row = {
        id: `case-${this.cases.length + 1}`,
        guild_id: message.guild_id,
        channel_id: message.channel_id,
        thread_id: message.thread_id,
        status: 'open',
        message_count: 1,
        summary: null,
        timeline: [],
        unresolved_questions: [],
        first_message_id: message.message_id,
        last_message_id: message.message_id,
        first_seen_at: message.timestamp,
        last_seen_at: message.timestamp,
      };
      this.cases.push(row);
      return row;
    },
    async updateCase(caseId, patch) {
      const idx = this.cases.findIndex((row) => row.id === caseId);
      this.cases[idx] = { ...this.cases[idx], ...patch };
      return this.cases[idx];
    },
    async linkMessage(caseId, message) {
      if (this.messages.some((row) => row.case_id === caseId && row.message_id === message.message_id)) {
        return false;
      }
      this.messages.push({ case_id: caseId, message_id: message.message_id });
      return true;
    },
    async createEvent(caseId, eventType, eventSummary) {
      this.events.push({ caseId, eventType, eventSummary });
    },
    async markMessageProcessed(messageId) {
      this.processed.push(messageId);
    },
    cleanRows: [],
  };
}

function createQdrant() {
  return {
    points: [],
    closedCases: [],
    async ensureCollectionExists() {},
    async fetchRecentCaseEmbeddings(caseId) {
      return this.points.filter((point) => point.payload.case_id === caseId && point.payload.case_status === 'open');
    },
    async searchActiveDiscussion() {
      const point = this.points.find((row) => row.payload.case_status === 'open');
      if (!point) return null;
      return {
        caseId: point.payload.case_id,
        score: 0.9,
        payload: point.payload,
      };
    },
    async upsertLiveMessage(message, caseRow, embedding) {
      const idx = this.points.findIndex((point) => point.payload.message_id === message.message_id);
      const point = {
        vector: embedding,
        payload: {
          message_id: message.message_id,
          case_id: caseRow.id,
          guild_id: message.guild_id,
          channel_id: message.channel_id,
          thread_id: message.thread_id,
          created_at: message.timestamp,
          case_status: caseRow.status || 'open',
        },
      };
      if (idx >= 0) this.points[idx] = point;
      else this.points.push(point);
    },
    async markCaseClosed(caseId) {
      this.closedCases.push(caseId);
      this.points = this.points.map((point) => (
        point.payload.case_id === caseId
          ? { ...point, payload: { ...point.payload, case_status: 'closed' } }
          : point
      ));
    },
  };
}

function message(id, content) {
  return {
    id,
    message_id: id,
    guild_id: 'guild',
    channel_id: 'channel',
    thread_id: null,
    user_id: `user-${id}`,
    username: `user-${id}`,
    content,
    timestamp: `2026-06-01T00:0${id}:00Z`,
  };
}

describe('LiveEngine', () => {
  it('creates the first case from zero state', async () => {
    const storage = createStorage();
    const msg = message('1', 'API returns 500');
    storage.cleanRows = [msg];
    const analyzeCase = jest.fn().mockResolvedValue({
      summary: 'Users report API 500 errors.',
      current_status: 'active',
      routing_type: 'product-side',
      attention_score: 'high',
      timeline: [{ time: msg.timestamp, summary: 'User reports API 500 errors' }],
      unresolved_questions: ['What is causing the failures?'],
      event_summary: 'New product-side API issue reported.',
    });

    const engine = new LiveEngine({
      storage,
      qdrant: createQdrant(),
      stateStore: new LiveStateStore(),
      embedText: jest.fn().mockResolvedValue([1, 0]),
      analyzeCase,
    });

    await engine.processMessage(msg);

    expect(storage.cases).toHaveLength(1);
    expect(storage.cases[0].summary).toContain('API 500');
    expect(storage.events[0].eventType).toBe('case_created');
    expect(storage.processed).toEqual(['1']);
    expect(analyzeCase).toHaveBeenCalledTimes(1);
  });

  it('closes the old case and starts a new one on semantic boundary', async () => {
    const storage = createStorage();
    const first = message('1', 'API returns 500');
    const second = message('2', 'Can GLM beat Claude?');
    storage.cleanRows = [first, second];
    const analyzeCase = jest.fn().mockResolvedValue({
      summary: 'Summary',
      current_status: 'active',
      routing_type: 'unknown',
      attention_score: 'low',
      timeline: [],
      unresolved_questions: [],
      event_summary: 'Updated',
    });

    const qdrant = createQdrant();
    const engine = new LiveEngine({
      storage,
      qdrant,
      stateStore: new LiveStateStore(),
      embedText: jest.fn()
        .mockResolvedValueOnce([1, 0])
        .mockResolvedValueOnce([0, 1]),
      analyzeCase,
    });

    await engine.processMessage(first);
    await engine.processMessage(second);

    expect(storage.cases).toHaveLength(2);
    expect(storage.cases[0].status).toBe('closed');
    expect(storage.cases[1].status).toBe('open');
    expect(storage.events.map((event) => event.eventType)).toContain('boundary_detected');
    expect(qdrant.closedCases).toEqual(['case-1']);
    expect(qdrant.points.map((point) => point.payload.case_id)).toEqual(['case-1', 'case-2']);
    expect(storage.processed).toEqual(['1', '2']);
  });

  it('does not increment case count when retry sees an already linked message', async () => {
    const storage = createStorage();
    const first = message('1', 'API returns 500');
    storage.cleanRows = [first];
    storage.cases.push({
      id: 'case-1',
      guild_id: 'guild',
      channel_id: 'channel',
      thread_id: null,
      status: 'open',
      message_count: 1,
      summary: 'Existing issue',
      timeline: [],
      unresolved_questions: [],
    });
    storage.messages.push({ case_id: 'case-1', message_id: '1' });

    const engine = new LiveEngine({
      storage,
      qdrant: createQdrant(),
      stateStore: new LiveStateStore(),
      embedText: jest.fn().mockResolvedValue([1, 0]),
      analyzeCase: jest.fn(),
    });

    await engine.processMessage(first);

    expect(storage.cases[0].message_count).toBe(1);
    expect(storage.messages).toHaveLength(1);
    expect(storage.processed).toEqual(['1']);
  });

  it('reruns missing first-case analysis during linked-message retry recovery', async () => {
    const storage = createStorage();
    const first = message('1', 'API returns 500');
    storage.cleanRows = [first];
    storage.cases.push({
      id: 'case-1',
      guild_id: 'guild',
      channel_id: 'channel',
      thread_id: null,
      status: 'open',
      message_count: 1,
      summary: null,
      timeline: [],
      unresolved_questions: [],
      first_message_id: '1',
    });
    storage.messages.push({ case_id: 'case-1', message_id: '1' });
    const analyzeCase = jest.fn().mockResolvedValue({
      summary: 'Recovered API issue summary.',
      current_status: 'active',
      routing_type: 'product-side',
      attention_score: 'high',
      timeline: [],
      unresolved_questions: [],
      event_summary: 'Recovered missing case analysis.',
    });

    const engine = new LiveEngine({
      storage,
      qdrant: createQdrant(),
      stateStore: new LiveStateStore(),
      embedText: jest.fn().mockResolvedValue([1, 0]),
      analyzeCase,
    });

    await engine.processMessage(first);

    expect(storage.cases[0].summary).toBe('Recovered API issue summary.');
    expect(storage.events.map((event) => event.eventType)).toEqual(['case_created']);
    expect(analyzeCase).toHaveBeenCalledTimes(1);
    expect(storage.processed).toEqual(['1']);
  });

  it('rebuilds open case state from Qdrant on startup', async () => {
    const storage = createStorage();
    storage.cases.push({
      id: 'case-1',
      guild_id: 'guild',
      channel_id: 'channel',
      thread_id: null,
      status: 'open',
      message_count: 2,
      first_seen_at: '2026-06-01T00:01:00Z',
      last_seen_at: '2026-06-01T00:02:00Z',
    });
    const qdrant = createQdrant();
    qdrant.points.push(
      { vector: [1, 0], payload: { case_id: 'case-1', case_status: 'open', created_at: '2026-06-01T00:01:00Z' } },
      { vector: [1, 0], payload: { case_id: 'case-1', case_status: 'open', created_at: '2026-06-01T00:02:00Z' } },
    );
    const stateStore = new LiveStateStore();

    const engine = new LiveEngine({
      storage,
      qdrant,
      stateStore,
      embedText: jest.fn(),
      analyzeCase: jest.fn(),
    });

    await engine.initialize();

    expect(stateStore.get('case-1').activeCentroid).toEqual([1, 0]);
    expect(stateStore.get('case-1').messageCount).toBe(2);
  });
});
