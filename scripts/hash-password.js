#!/usr/bin/env node

import process from "node:process";

import { createPasswordHash } from "../src/security.js";

const password = process.argv[2];

if (!password) {
  process.stderr.write(
    "Usage: node scripts/hash-password.js '<strong-password>'\n",
  );
  process.exit(1);
}

process.stdout.write(`${createPasswordHash(password)}\n`);
