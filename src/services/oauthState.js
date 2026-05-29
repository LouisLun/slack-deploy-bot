const crypto = require('crypto');

const states = new Map();
const TTL_MS = 10 * 60 * 1000;

function createState(data) {
  const key = crypto.randomBytes(16).toString('hex');
  states.set(key, { ...data, createdAt: Date.now() });
  setTimeout(() => states.delete(key), TTL_MS);
  return key;
}

function consumeState(key) {
  const state = states.get(key);
  if (!state) return null;
  states.delete(key);
  return state;
}

module.exports = { createState, consumeState };
