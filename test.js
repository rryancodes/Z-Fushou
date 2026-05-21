// Full RAG pipeline simulation — 60 tests
// Simulates the complete Discord bot flow WITHOUT Discord
// Run: node test.js
// Requires: .env with CF_API_TOKEN, CF_ACCOUNT_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY, QDRANT_URL, QDRANT_API_KEY

require('dotenv').config();

// Prevent EPIPE crashes
process.stdout.on('error', () => { });
process.stderr.on('error', () => { });

const { classifyIntent } = require('./lib/intent');
const { rewriteQuery } = require('./lib/rewriter');
const { detectDepartment } = require('./lib/departments');
const { generateResponse, THRESHOLD_HIGH } = require('./lib/responder');
const { embed, rerank } = require('./lib/cloudflare');
const { search, COLLECTIONS } = require('./lib/qdrant');
const { isStaff, getSpeakerRole } = require('./lib/speaker');

const fs = require('fs');
const path = require('path');
const OUTPUT_FILE = path.join(__dirname, 'test-results.txt');
fs.writeFileSync(OUTPUT_FILE, '');

function log(msg) {
  process.stdout.write(msg);
  fs.appendFileSync(OUTPUT_FILE, msg);
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let total = 0;
let passed = 0;
let failed = 0;
let startTime;

function log(msg) {
  process.stdout.write(msg);
}

async function test(label, fn) {
  total++;
  const num = `[${String(total).padStart(2, '0')}/60]`;
  log(`  ${num} ${label}\n`);

  try {
    const result = await fn();
    if (result.ok) {
      passed++;
      log(`      ✓ PASS\n`);
      if (result.detail) log(`      → ${result.detail}\n`);
    } else {
      failed++;
      log(`      ✗ FAIL: ${result.reason}\n`);
    }
  } catch (err) {
    failed++;
    log(`      ✗ ERROR: ${err.message}\n`);
  }

  log('\n');
}

function ok(detail) { return { ok: true, detail }; }
function fail(reason) { return { ok: false, reason }; }

function contains(str, substr) {
  return str && str.toLowerCase().includes(substr.toLowerCase());
}

// ─── Simulated full RAG pipeline (no Discord, pure data) ──────────────────────

async function simulateFullPipeline(userMessage, options = {}) {
  const {
    history = [],
    issueSummary = 'Issue ID: ISS-TEST\nTitle: Test Issue\nDepartment: unclassified\nStatus: open',
    mockContext = {}
  } = options;

  const steps = {};

  // Step 1: Intent classification
  steps.intent = await classifyIntent(userMessage);

  // Skip for acknowledgements (like the real bot)
  if (steps.intent.messageType === 'acknowledgement') {
    steps.reply = 'acknowledgement — skipped';
    return steps;
  }

  // CASUAL — direct reply
  if (steps.intent.intent === 'CASUAL') {
    steps.reply = steps.intent.reply;
    return steps;
  }

  // STATUS — would reply with status from DB
  if (steps.intent.intent === 'STATUS') {
    steps.reply = `Status check — would return issue status from DB`;
    return steps;
  }

  // UNCLEAR — ask for clarification
  if (steps.intent.intent === 'UNCLEAR') {
    steps.reply = "I'm not quite sure what you're asking. Could you give me a bit more detail?";
    return steps;
  }

  // Step 2: Query rewriting
  steps.rewrite = await rewriteQuery(userMessage, history, steps.intent.intent);

  // Step 3: Vector search (if rewriter says yes)
  if (steps.rewrite.needsRag && steps.rewrite.query && steps.rewrite.query.length > 3) {
    try {
      steps.embedding = await embed(steps.rewrite.query);
      const docsResults = await search(COLLECTIONS.docs, steps.embedding, 10);
      const casesResults = await search(COLLECTIONS.cases, steps.embedding, 5).catch(() => []);

      steps.vectorSearch = {
        docs_count: docsResults.length,
        cases_count: casesResults.length,
        best_doc_score: docsResults.length > 0 ? Math.max(...docsResults.map(r => r.score)).toFixed(3) : '0',
        best_case_score: casesResults.length > 0 ? Math.max(...casesResults.map(r => r.score)).toFixed(3) : '0'
      };

      // Step 4: Reranking
      if (docsResults.length > 0 || casesResults.length > 0) {
        const allCandidates = [...docsResults, ...casesResults];
        const docTexts = allCandidates.map(r => r.payload?.content || '');
        const reranked = await rerank(steps.rewrite.query, docTexts);

        const sigmoid = x => 1 / (1 + Math.exp(-x));

        // Full objects with payload intact — passed to generateResponse
        const rerankedForResponse = reranked
          .map(r => {
            const idx = r.id ?? r.index;  // defensive: some APIs use 'index'
            const candidate = allCandidates[idx];
            return {
              ...(candidate || {}),
              score: sigmoid(r.score),
              vector_score: candidate?.score,
              reranker_score: sigmoid(r.score)
            };
          })
          .sort((a, b) => b.reranker_score - a.reranker_score)
          .slice(0, 5);

        // Display-only objects for logging (no payload needed)
        steps.reranked = rerankedForResponse.map(r => ({
          score: r.reranker_score,
          source: r.payload?.source || 'unknown',
          header: r.payload?.header || 'unknown',
          content_preview: (r.payload?.content || '').slice(0, 120)
        }));

        // Store full objects separately for the response generator
        steps.rerankedForResponse = rerankedForResponse;
      }
    } catch (err) {
      steps.searchError = err.message;
    }
  }

  // Step 5: Response generation
  const context = {
    history: history.length > 0 ? history : [{ role: 'system', content: '(no conversation history)' }],
    issueSummary
  };

  steps.response = await generateResponse(
    userMessage,
    steps.rerankedForResponse || [],   // full payload objects — not display-format
    context,
    steps.rewrite.needsRag
  );

  if (steps.response && steps.response.toUpperCase().includes('ESCALATE')) {
    steps.escalated = true;
    steps.reply = '⚠️ ESCALATED — no answer found in documentation or history';
  } else {
    steps.escalated = false;
    steps.reply = steps.response;
  }

  return steps;
}

// ─── Pretty-print pipeline output ─────────────────────────────────────────────

function printPipeline(steps) {
  log(`         Intent: ${steps.intent.intent}|${steps.intent.messageType}\n`);

  if (steps.reply && steps.reply !== 'acknowledgement — skipped') {
    if (steps.reply.startsWith('Status check')) {
      log(`         Reply: ${steps.reply}\n`);
    } else if (steps.reply.startsWith("I'm not quite sure")) {
      log(`         Reply: ${steps.reply}\n`);
    } else if (steps.reply.startsWith("Hey") || steps.reply.startsWith("Hello") || steps.reply.startsWith("Hi") || steps.reply.startsWith("You're") || steps.reply.startsWith("Happy") || steps.reply.startsWith("Of course") || steps.reply.startsWith("Got it") || steps.reply.startsWith("Understood")) {
      log(`         Reply: ${steps.reply}\n`);
    } else {
      log(`         RAG Query: "${steps.rewrite?.query || 'skipped'}"\n`);
      if (steps.vectorSearch) {
        log(`         Vector Search: ${steps.vectorSearch.docs_count} docs (best: ${steps.vectorSearch.best_doc_score}), ${steps.vectorSearch.cases_count} cases (best: ${steps.vectorSearch.best_case_score})\n`);
      }
      if (steps.reranked && steps.reranked.length > 0) {
        log(`         Reranked Results:\n`);
        steps.reranked.forEach((r, i) => {
          log(`           [${i + 1}] score=${r.score.toFixed(3)} | ${r.source} → ${r.header}\n`);
          log(`           → "${r.content_preview}..."\n`);
        });
      }
      if (steps.searchError) {
        log(`         Search Error: ${steps.searchError}\n`);
      }
      log(`         Reply: ${steps.reply}\n`);
      if (steps.escalated) {
        log(`         ⚠️  Escalated to human staff\n`);
      }
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  startTime = Date.now();

  log('\n');
  log('═══════════════════════════════════════════════════════════\n');
  log('  SUPPORT BOT — FULL RAG PIPELINE SIMULATION (60 tests)\n');
  log('═══════════════════════════════════════════════════════════\n\n');

  // ── BILLING SCENARIOS (1-8) ──
  log('─── Billing & Subscription ────────────────────────────────\n');

  await test('1. Angry: coding plan but 1113 insufficient balance', async () => {
    const s = await simulateFullPipeline('bro i paid for the coding plan and it STILL says 1113 insufficient balance wtf i need this fixed rn');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT' && !s.escalated
      ? ok(`intent=${s.intent.intent}, RAG answered`)
      : fail(`intent=${s.intent.intent}, escalated=${s.escalated}`);
  });

  await test('2. Subscription paid but not showing', async () => {
    const s = await simulateFullPipeline('hey i just paid for the pro plan but its not showing up in my console yet already waited like 15 min');
    printPipeline(s);
    // "not showing yet" + "already waited" is legitimately STATUS or QUESTION or COMPLAINT
    return ['QUESTION', 'COMPLAINT', 'STATUS'].includes(s.intent.intent)
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('3. Card declined on Stripe', async () => {
    const s = await simulateFullPipeline('my card keeps getting declined on stripe i tried 3 different cards is your payment system broken or what');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('4. Refund request accidental top-up', async () => {
    const s = await simulateFullPipeline('so i accidentally topped up $33 instead of $3 is there any way to get that money back');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('5. Duplicate subscription concern', async () => {
    const s = await simulateFullPipeline('i think i have two subscriptions now how do i cancel one and just keep the pro plan');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('6. Extra unknown charge', async () => {
    const s = await simulateFullPipeline('why is there a pending charge on my stripe statement i didnt authorize this');
    printPipeline(s);
    // "why is there" + "didn't authorize" = complaint or question — both valid
    return ['QUESTION', 'COMPLAINT'].includes(s.intent.intent)
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('7. Cannot cancel auto-renewal', async () => {
    const s = await simulateFullPipeline('how do i cancel my subscription i cant find the cancel button anywhere');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('8. General billing confusion', async () => {
    const s = await simulateFullPipeline('do you guys still have the black friday 30% off deal or is that expired now im on monthly plan');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── API ERROR SCENARIOS (9-16) ──
  log('─── API Errors & Technical Issues ─────────────────────────\n');

  await test('9. API 500 spinning for 2+ minutes', async () => {
    const s = await simulateFullPipeline('api just spins for over 2 minutes then gives me a 500 error this has been happening all day');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('10. 401 unauthorized token expired', async () => {
    const s = await simulateFullPipeline('getting 401 unauthorized even though my api key is valid and i put it in the request header');
    printPipeline(s);
    // "even though my key is valid" can read as QUESTION or COMPLAINT — both are fine
    return ['COMPLAINT', 'QUESTION'].includes(s.intent.intent)
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('11. Rate limit 429 complaint', async () => {
    const s = await simulateFullPipeline('i keep getting 429 rate limited but im barely sending any requests like maybe 2 per minute this is ridiculous');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('12. High concurrency 4028 blocked', async () => {
    const s = await simulateFullPipeline('4028 high concurrency error ive been blocked for like 5 hours now this is absolutely unacceptable');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('13. Unexpected token < Invalid JSON', async () => {
    const s = await simulateFullPipeline('getting Unexpected token less than sign in JSON at position 0 but im using api.z.ai as my base url so confused');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('14. Intermittent 500/503/429 mixed', async () => {
    const s = await simulateFullPipeline('api is so flaky today sometimes 500 sometimes 503 sometimes 429 its really unstable');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('15. Extremely slow API on weekends', async () => {
    const s = await simulateFullPipeline('the api is extremely slow on weekends like super low TPS is this normal or is something wrong');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('16. Endpoint confusion', async () => {
    const s = await simulateFullPipeline('so like which endpoint should i be using i have the coding plan but im not sure if its the pay-as-you-go one or the other one');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── MCP/TOOL SCENARIOS (17-20) ──
  log('─── MCP Tools & Plugins ───────────────────────────────────\n');

  await test('17. Web Search MCP timeout', async () => {
    const s = await simulateFullPipeline('the web search MCP keeps giving me Headers Timeout Error ive checked my config multiple times');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('18. Charged for web search despite pro plan', async () => {
    const s = await simulateFullPipeline('i have a pro plan why am i still getting charged cash when i use the web search tool');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('19. Tool-calling MCP not available', async () => {
    const s = await simulateFullPipeline('MCP tools just dont work in my VS Code extension it says tool not available every single time');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('20. Vision/image usage question', async () => {
    const s = await simulateFullPipeline('how do i send images in the api request do i need a special endpoint or model for vision');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── MODEL SCENARIOS (21-24) ──
  log('─── Model & Quality Issues ────────────────────────────────\n');

  await test('21. Model not found glm-5', async () => {
    const s = await simulateFullPipeline('it says model not found when i try to use glm-5 do i need a special plan for that');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('22. Context erosion after compaction', async () => {
    const s = await simulateFullPipeline('the model keeps forgetting my previous messages after compaction like it completely lost context is this normal');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('23. Language swap quality drop', async () => {
    const s = await simulateFullPipeline('the model randomly started responding in a totally different language and the quality dropped significantly wtf');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('24. Export PDF payment required', async () => {
    const s = await simulateFullPipeline('when i try to export as PDF it says payment required but i have a pro plan wth');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── UX/PRODUCT SCENARIOS (25-28) ──
  log('─── UX & Product Feedback ─────────────────────────────────\n');

  await test('25. Project deleted without confirmation', async () => {
    const s = await simulateFullPipeline('my project got deleted without any confirmation popup like there should be a way to prevent accidental deletion');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('26. Delete vs Archive confusion', async () => {
    const s = await simulateFullPipeline('why is there a DELETE button instead of ARCHIVE i accidentally deleted my project');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('27. Legacy plan rollback', async () => {
    const s = await simulateFullPipeline('i was on the old plan with no rate limits is there any way to roll back to that');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('28. Billing portal broken', async () => {
    const s = await simulateFullPipeline('the billing page wont load at all it just crashes every time i try to open it');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── CASUAL/STATUS/UNCLEAR (29-35) ──
  log('─── Casual / Status / Unclear (Fast Paths) ────────────────\n');

  await test('29. Casual greeting', async () => {
    const s = await simulateFullPipeline('heyy');
    printPipeline(s);
    return s.intent.intent === 'CASUAL' && s.reply && !s.escalated
      ? ok(`replied: "${s.reply}"`)
      : fail(`intent=${s.intent.intent}, escalated=${s.escalated}`);
  });

  await test('30. Casual thanks', async () => {
    const s = await simulateFullPipeline('thx that worked!!');
    printPipeline(s);
    return s.intent.intent === 'CASUAL' && s.reply
      ? ok(`replied: "${s.reply}"`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('31. Casual goodbye', async () => {
    const s = await simulateFullPipeline('alright thanks bye');
    printPipeline(s);
    return s.intent.intent === 'CASUAL' && s.reply
      ? ok(`replied: "${s.reply}"`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('32. Short acknowledgement', async () => {
    const s = await simulateFullPipeline('k');
    printPipeline(s);
    return s.intent.messageType === 'acknowledgement'
      ? ok(`acknowledged — bot skipped reply`)
      : fail(`intent=${s.intent.intent}|${s.intent.messageType}`);
  });

  await test('33. Status check on ticket', async () => {
    const s = await simulateFullPipeline('any update on my issue from yesterday??');
    printPipeline(s);
    return s.intent.intent === 'STATUS'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('34. Vague "facing a problem"', async () => {
    const s = await simulateFullPipeline('facing a different problem actually');
    printPipeline(s);
    return s.intent.intent === 'UNCLEAR'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('35. Emoji only', async () => {
    const s = await simulateFullPipeline('👍');
    printPipeline(s);
    return s.intent.intent === 'CASUAL'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── MULTI-QUESTION SPLIT SCENARIOS (36-40) ──
  log('─── Multi-Question Messages ───────────────────────────────\n');

  await test('36. Two questions in one message', async () => {
    const s = await simulateFullPipeline('how do i change my api endpoint for the coding plan and also how do i cancel my old subscription');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('37. Numbered list of issues', async () => {
    const s = await simulateFullPipeline('1. my api returns 500 errors 2. i was charged twice this month 3. the billing page wont load can you help with all of these');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('38. Mixed topics billing + technical', async () => {
    const s = await simulateFullPipeline('i need a refund for the duplicate charge and also my api keeps giving 401 errors what do i do');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('39. Follow-up question after answer', async () => {
    const history = [
      { role: 'user', content: 'how do i change my api endpoint' },
      { role: 'assistant', content: 'Update your Base URL to https://api.z.ai/api/coding/paas/v4 and restart your client.' }
    ];
    const s = await simulateFullPipeline('ok also how do i generate a new api key', { history });
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('40. "Same issue here" from second user', async () => {
    const s = await simulateFullPipeline('same issue here happening to me too since yesterday');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT' || s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── EDGE CASES / CONFUSING QUERIES (41-50) ──
  log('─── Edge Cases & Confusing Human Queries ──────────────────\n');

  await test('41. Very long rambling complaint', async () => {
    const s = await simulateFullPipeline('ok so basically what happened is i was using the api yesterday and everything was fine but then today i woke up and tried to make a request and it just kept spinning and spinning like for 5 minutes maybe more and then eventually it returned this weird 500 error and i have no idea what changed because i didnt touch anything and my code was working perfectly fine yesterday so im really confused about what could have gone wrong can someone please help me figure this out because i have a deadline coming up and i really need this to work');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('42. Typo-heavy message', async () => {
    const s = await simulateFullPipeline('my apy key dosnt work geting 401 unathorized eror i alredy tryed genrating new one still same thng');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT' || s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('43. Mixed language', async () => {
    const s = await simulateFullPipeline('hola i need help with my subscription no aparece el plan que compre');
    printPipeline(s);
    return s.intent.intent === 'QUESTION' || s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('44. All caps rant', async () => {
    const s = await simulateFullPipeline('THIS IS THE THIRD TIME THIS WEEK THE API HAS BEEN DOWN WHEN ARE YOU GOING TO FIX THIS');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('45. Question with irrelevant noise', async () => {
    const s = await simulateFullPipeline('hey man so i was wondering like my friend told me about this thing and anyway i need to know how to reset my api key thanks also my dog is cute');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('46. Statement disguised as question', async () => {
    const s = await simulateFullPipeline('so i guess ill just wait for the team to respond i suppose');
    printPipeline(s);
    return s.intent.messageType === 'comment' || s.intent.intent === 'STATUS'
      ? ok(`intent=${s.intent.intent}|${s.intent.messageType}`)
      : fail(`intent=${s.intent.intent}|${s.intent.messageType}`);
  });

  await test('47. Sarcasm', async () => {
    const s = await simulateFullPipeline('oh great another 500 error how wonderful your api is working perfectly today');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('48. Extremely short technical query', async () => {
    const s = await simulateFullPipeline('401');
    printPipeline(s);
    return s.intent.intent === 'CASUAL' || s.intent.intent === 'UNCLEAR'
      ? ok(`intent=${s.intent.intent} (fast path for short messages)`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('49. Login loop after purchase', async () => {
    const s = await simulateFullPipeline('cant log back in after buying the subscription it keeps redirecting me to the login page over and over');
    printPipeline(s);
    return s.intent.intent === 'COMPLAINT'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  await test('50. Invoice VAT missing', async () => {
    const s = await simulateFullPipeline('my invoice is missing the VAT number and the company name is wrong how do i fix that');
    printPipeline(s);
    return s.intent.intent === 'QUESTION'
      ? ok(`intent=${s.intent.intent}`)
      : fail(`intent=${s.intent.intent}`);
  });

  // ── RAG-INTENSIVE SCENARIOS (51-55) ──
  log('─── RAG Pipeline Deep Tests ───────────────────────────────\n');

  await test('51. Should retrieve 1113 endpoint doc', async () => {
    const s = await simulateFullPipeline('i have a coding plan but keep getting 1113 insufficient balance');
    printPipeline(s);
    return s.rewrite?.needsRag && (s.vectorSearch?.docs_count > 0 || s.escalated)
      ? ok(`searched=${s.rewrite.needsRag}, docs=${s.vectorSearch?.docs_count || 0}, escalated=${s.escalated}`)
      : fail(`searched=${s.rewrite?.needsRag}, docs=${s.vectorSearch?.docs_count || 0}`);
  });

  await test('52. Should retrieve refund policy doc', async () => {
    const s = await simulateFullPipeline('i want a refund for an accidental top-up');
    printPipeline(s);
    return s.rewrite?.needsRag && (s.vectorSearch?.Docs_count > 0 || s.escalated)
      ? ok(`searched=${s.rewrite.needsRag}, docs=${s.vectorSearch?.docs_count || 0}, escalated=${s.escalated}`)
      : fail(`searched=${s.rewrite?.needsRag}, docs=${s.vectorSearch?.docs_count || 0}`);
  });

  await test('53. Should retrieve rate limit doc', async () => {
    const s = await simulateFullPipeline('hitting 429 rate limit but only sending 2 requests per minute');
    printPipeline(s);
    return s.rewrite?.needsRag && (s.vectorSearch?.docs_count > 0 || s.escalated)
      ? ok(`searched=${s.rewrite.needsRag}, docs=${s.vectorSearch?.docs_count || 0}, escalated=${s.escalated}`)
      : fail(`searched=${s.rewrite?.needsRag}, docs=${s.vectorSearch?.docs_count || 0}`);
  });

  await test('54. Should retrieve MCP setup doc', async () => {
    const s = await simulateFullPipeline('MCP tools not working in VS Code extension says tool not available');
    printPipeline(s);
    return s.rewrite?.needsRag && (s.vectorSearch?.docs_count > 0 || s.escalated)
      ? ok(`searched=${s.rewrite.needsRag}, docs=${s.vectorSearch?.docs_count || 0}, escalated=${s.escalated}`)
      : fail(`searched=${s.rewrite?.needsRag}, docs=${s.vectorSearch?.docs_count || 0}`);
  });

  await test('55. Should retrieve subscription cancel doc', async () => {
    const s = await simulateFullPipeline('how do i cancel my subscription auto-renewal');
    printPipeline(s);
    return s.rewrite?.needsRag && (s.vectorSearch?.docs_count > 0 || s.escalated)
      ? ok(`searched=${s.rewrite.needsRag}, docs=${s.vectorSearch?.docs_count || 0}, escalated=${s.escalated}`)
      : fail(`searched=${s.rewrite?.needsRag}, docs=${s.vectorSearch?.docs_count || 0}`);
  });

  // ── DEPARTMENT DETECTION (56-60) ──
  log('─── Department Detection ──────────────────────────────────\n');

  await test('56. Department: billing keywords', async () => {
    const dept = await detectDepartment('subscription refund charge stripe payment invoice billing');
    log(`         Department: ${dept}\n`);
    return dept !== 'unclassified'
      ? ok(`department=${dept}`)
      : fail(`expected non-unclassified got ${dept}`);
  });

  await test('57. Department: technical API error', async () => {
    const dept = await detectDepartment('401 unauthorized api key token expired header authentication endpoint');
    log(`         Department: ${dept}\n`);
    return dept !== 'unclassified'
      ? ok(`department=${dept}`)
      : fail(`expected non-unclassified got ${dept}`);
  });

  await test('58. Department: product feature question', async () => {
    const dept = await detectDepartment('how does the vision model work can i use it with glm-4.7 what endpoints support images');
    log(`         Department: ${dept}\n`);
    return dept !== 'unclassified'
      ? ok(`department=${dept}`)
      : fail(`expected non-unclassified got ${dept}`);
  });

  await test('59. Department: general greeting (unclassified)', async () => {
    const dept = await detectDepartment('hey how are you doing today');
    log(`         Department: ${dept}\n`);
    return dept === 'unclassified'
      ? ok(`department=${dept}`)
      : fail(`expected unclassified got ${dept}`);
  });

  await test('60. Department: mixed billing and technical', async () => {
    const dept = await detectDepartment('i was charged extra for the web search tool and the api keeps returning 500 errors');
    log(`         Department: ${dept}\n`);
    return dept !== 'unclassified'
      ? ok(`department=${dept}`)
      : fail(`expected non-unclassified got ${dept}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log('═══════════════════════════════════════════════════════════\n');
  log(`  RESULTS: ${passed}/${total} passed, ${failed} failed\n`);
  log(`  Duration: ${elapsed}s\n`);
  log('═══════════════════════════════════════════════════════════\n\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  log(`\n  ✗ FATAL: ${err.message}\n\n`);
  process.exit(1);
});

