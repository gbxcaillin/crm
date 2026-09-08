#!/usr/bin/env node
// Prints a new 256-bit data key. Put it in .env.production as DATA_KEYS=v1:<key>
// (or prepend v2:<key>, to the existing list to start a rotation).
console.log(require('../lib/vault').newKey());
