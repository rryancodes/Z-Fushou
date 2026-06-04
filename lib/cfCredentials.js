/**
 * Cloudflare credential rotation — switches between two credential sets
 * every 12 hours to avoid exhausting the daily free neuron quota on a
 * single account.
 *
 * Shift 1: UTC 00:00 – 11:59  →  CF_ACCOUNT_ID_SHIFT_1 / CF_API_TOKEN_SHIFT_1
 * Shift 2: UTC 12:00 – 23:59  →  CF_ACCOUNT_ID_SHIFT_2 / CF_API_TOKEN_SHIFT_2
 */

const SHIFT_1 = {
  accountId: process.env.CF_ACCOUNT_ID_SHIFT_1,
  apiToken: process.env.CF_API_TOKEN_SHIFT_1,
};

const SHIFT_2 = {
  accountId: process.env.CF_ACCOUNT_ID_SHIFT_2,
  apiToken: process.env.CF_API_TOKEN_SHIFT_2,
};

let lastShift = null;

/**
 * Returns the active shift index (0 or 1) based on the current UTC hour.
 * @returns {number}
 */
function currentShiftIndex() {
  return Math.floor(new Date().getUTCHours() / 12);
}

/**
 * Returns the credentials for a specific shift.
 * @param {number} shiftIndex - 0 for Shift 1, 1 for Shift 2
 * @returns {{ accountId: string, apiToken: string, shift: number }}
 */
function getCredentialsForShift(shiftIndex) {
  const creds = shiftIndex === 0 ? SHIFT_1 : SHIFT_2;
  return {
    accountId: creds.accountId,
    apiToken: creds.apiToken,
    shift: shiftIndex,
  };
}

/**
 * Returns the currently active credentials based on the current UTC hour.
 * Logs a notice when a shift transition is detected.
 *
 * @returns {{ accountId: string, apiToken: string, shift: number }}
 */
function getCredentials() {
  const shift = currentShiftIndex();

  if (lastShift !== null && lastShift !== shift) {
    const fromLabel = lastShift === 0 ? 'Shift 1' : 'Shift 2';
    const toLabel = shift === 0 ? 'Shift 1' : 'Shift 2';
    console.log(`[cfCredentials] Shift transition detected — switching from ${fromLabel} to ${toLabel}`);
  }

  lastShift = shift;
  return getCredentialsForShift(shift);
}

/**
 * Validates that both shift credential sets are present.
 * Call this at startup to fail fast on misconfiguration.
 *
 * @throws {Error} if any credential is missing
 */
function validateCredentials() {
  const missing = [];

  if (!SHIFT_1.accountId) missing.push('CF_ACCOUNT_ID_SHIFT_1');
  if (!SHIFT_1.apiToken) missing.push('CF_API_TOKEN_SHIFT_1');
  if (!SHIFT_2.accountId) missing.push('CF_ACCOUNT_ID_SHIFT_2');
  if (!SHIFT_2.apiToken) missing.push('CF_API_TOKEN_SHIFT_2');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const activeShift = currentShiftIndex();
  const label = activeShift === 0 ? 'Shift 1' : 'Shift 2';
  const hours = activeShift === 0 ? '0-11' : '12-23';
  console.log(`[cfCredentials] ${label} credentials active (UTC hours ${hours}). Switches at ${activeShift === 0 ? '12:00' : '00:00'} UTC.`);
}

module.exports = { getCredentials, getCredentialsForShift, validateCredentials, currentShiftIndex };
