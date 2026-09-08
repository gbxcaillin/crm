#!/usr/bin/env node
// Re-seals every encrypted row with the current (first) key in DATA_KEYS. Run inside the container:
//   docker compose exec crm node server/tools/rotate.js
// then drop the old key from DATA_KEYS and restart.
const D = require('../lib/db');
const n = D.resealAll(true);
console.log(`re-sealed ${n} rows with ${require('../lib/vault').current()}`);
