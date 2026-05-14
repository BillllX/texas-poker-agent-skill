#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const source = path.resolve(__dirname, "..");
  const target = path.join(os.homedir(), ".cursor", "skills", "texas-poker-club-agent");

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, {
    recursive: true,
    filter: (item) => {
      const base = path.basename(item);
      return base !== "node_modules" && base !== "config.local.json" && base !== ".texas-poker-agent-memory.json";
    },
  });

  console.log(`Installed Texas Poker Club Agent skill to ${target}`);
  console.log("Run: cd ~/.cursor/skills/texas-poker-club-agent && npm install && npm run doctor");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
