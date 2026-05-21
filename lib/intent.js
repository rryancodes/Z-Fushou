// lib/intent.js
const { chatFast } = require('./cloudflare');

const INTENT_PROMPT = `You are an intent classifier for a product support system.
Classify the user message into exactly one intent AND one message type.

INTENTS:
CASUAL - greetings, thanks, acknowledgements, small talk
QUESTION - asking about product features, pricing, how things work, documentation
COMPLAINT - reporting something broken, expressing frustration about a bug or issue
STATUS - asking about status of their specific issue, when it will be fixed, any updates
UNCLEAR - too vague or ambiguous to classify

MESSAGE TYPES:
question - user is asking something new
followup - user references something discussed earlier in the conversation
comment - user makes a statement or reaction, not asking anything
acknowledgement - user confirms receipt, says ok/thanks/got it — no reply needed

Respond with ONLY: INTENT|TYPE
Nothing else. No explanation.

Examples:
"hi there" → CASUAL|acknowledgement
"thanks!" → CASUAL|acknowledgement
"how do I reset my password?" → QUESTION|question
"what about the endpoint from earlier?" → QUESTION|followup
"same issue here" → QUESTION|comment
"my app keeps crashing" → COMPLAINT|question
"this is so frustrating" → COMPLAINT|comment
"any update?" → STATUS|followup
"ok" → CASUAL|acknowledgement
"..." → UNCLEAR|comment
"si gracias" → CASUAL|acknowledgement
"👌" → CASUAL|acknowledgement
"oke" → CASUAL|acknowledgement`;

const CASUAL_REPLIES = {
  greeting: [
    "Hey! I'm here to help. What can I assist you with?",
    "Hello! How can I help you today?",
    "Hi there! What's going on?"
  ],
  thanks: [
    "You're welcome! Let me know if there's anything else I can help with.",
    "Happy to help! Anything else?",
    "Of course! Feel free to ask if you need anything else."
  ],
  bye: [
    "Goodbye! If your issue isn't resolved yet, a team member will follow up.",
    "Take care! We'll keep working on your issue."
  ],
  general: [
    "Got it! Let me know if you have any questions.",
    "Understood. I'm here if you need anything."
  ]
};

function getCasualReply(message) {
  const lower = message.toLowerCase().trim();
  if (/^(hi|hey|hello|hiya|heya|howdy|sup|yo|greetings)\b/.test(lower)) {
    const replies = CASUAL_REPLIES.greeting;
    return replies[Math.floor(Math.random() * replies.length)];
  }
  if (/^(bye|goodbye|see you|cya|later|ttyl|gotta go)\b/.test(lower)) {
    const replies = CASUAL_REPLIES.bye;
    return replies[Math.floor(Math.random() * replies.length)];
  }
  if (/^(thanks|thank you|thx|ty|cheers|appreciate|grateful)\b/.test(lower)) {
    const replies = CASUAL_REPLIES.thanks;
    return replies[Math.floor(Math.random() * replies.length)];
  }
  const replies = CASUAL_REPLIES.general;
  return replies[Math.floor(Math.random() * replies.length)];
}

async function classifyIntent(message) {
  const VALID_INTENTS = ['CASUAL', 'QUESTION', 'COMPLAINT', 'STATUS', 'UNCLEAR'];
  const VALID_TYPES = ['question', 'followup', 'comment', 'acknowledgement'];

  // Fast path: very short messages are almost always CASUAL acknowledgements
  // Avoids LLM call for obvious cases
  const trimmed = message.trim();
  if (trimmed.length <= 6) {
    return { intent: 'CASUAL', messageType: 'acknowledgement', reply: getCasualReply(trimmed) };
  }

  // Fast-path: vague "facing a problem" style messages with no specifics → UNCLEAR
  if (/^(but\s+)?(i[' ]?m\s+)?(facing|having|experiencing)\s+(a\s+)?(bigger|different|another|new|serious|major|other)\s+problem/i.test(trimmed)) {
    return { intent: 'UNCLEAR', messageType: 'comment', reply: null };
  }

  let intent, messageType;
  try {
    const result = await chatFast(INTENT_PROMPT, [
      { role: 'user', content: trimmed }
    ]);

    // Guard against null/empty LLM response
    if (!result || typeof result !== 'string' || !result.trim()) {
      console.warn('[intent] LLM returned empty/null — defaulting to QUESTION|question');
      intent = 'QUESTION';
      messageType = 'question';
    } else {
      // Parse "INTENT|TYPE" format
      const parsed = result.trim().toUpperCase().split('|');
      const rawIntent = parsed[0].trim();
      const rawType = (parsed[1] || '').trim().toLowerCase();

      intent = VALID_INTENTS.includes(rawIntent) ? rawIntent : 'QUESTION';
      messageType = VALID_TYPES.includes(rawType) ? rawType : 'question';
    }
  } catch (err) {
    console.error('[intent] Classification failed:', err.message);
    intent = 'QUESTION';
    messageType = 'question';
  }

  console.log(`[intent] Classified: ${intent}|${messageType}`);

  const reply = intent === 'CASUAL' ? getCasualReply(trimmed) : null;
  return { intent, messageType, reply };
}

module.exports = { classifyIntent };
