const { LiveStateStore, shouldGenerateTimelineUpdate } = require('../state');

describe('LiveStateStore', () => {
  it('requires both cohesion drop and low similarity to mark a boundary', () => {
    const store = new LiveStateStore();
    const state = store.set('case-1', {
      activeCentroid: [1, 0],
      recentEmbeddings: [[1, 0]],
      cohesionScore: 0.9,
      messageCount: 1,
      userIds: new Set(),
    });

    const noBoundary = store.evaluateBoundary(state, [0.7, 0.7141], {
      COHESION_DROP_THRESHOLD: 0.16,
      SIMILARITY_BOUNDARY_THRESHOLD: 0.62,
    });
    expect(noBoundary.cohesionDrop).toBeGreaterThanOrEqual(0.16);
    expect(noBoundary.isBoundary).toBe(false);

    const boundary = store.evaluateBoundary(state, [0.5, 0.866], {
      COHESION_DROP_THRESHOLD: 0.16,
      SIMILARITY_BOUNDARY_THRESHOLD: 0.62,
    });
    expect(boundary.isBoundary).toBe(true);
  });

  it('updates centroid against the discussion, not only the previous message', () => {
    const store = new LiveStateStore();
    store.init('case-1', { timestamp: '2026-06-01T00:00:00Z' }, [1, 0]);
    store.append('case-1', { timestamp: '2026-06-01T00:01:00Z' }, [1, 0], 1);
    const state = store.append('case-1', { timestamp: '2026-06-01T00:02:00Z' }, [0, 1], 0);

    expect(state.activeCentroid[0]).toBeCloseTo(0.8944, 3);
    expect(state.activeCentroid[1]).toBeCloseTo(0.4472, 3);
  });
});

describe('timeline update gating', () => {
  it('does not call an error message significant before enough messages accumulate', () => {
    const state = { processedSinceAnalysis: 1 };
    expect(shouldGenerateTimelineUpdate(state, { content: 'api error 500' })).toBe(false);
  });

  it('allows immediate resolution signals', () => {
    const state = { processedSinceAnalysis: 0 };
    expect(shouldGenerateTimelineUpdate(state, { content: 'this is fixed now' })).toBe(true);
  });
});
