#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");
const { checkForUpdates, formatUpdateNotice, hasUpdate } = require("./version-check");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  await assertCleanWorkingTree();

  const status = await checkForUpdates({ root: ROOT, fetchRemote: true });
  const notice = formatUpdateNotice(status);
  if (!hasUpdate(status)) {
    console.log("Texas Poker Agent Skill is already up to date.");
    return;
  }

  console.log(notice);
  await run("git", ["pull", "--ff-only"], ROOT);
  await run("npm", ["install"], ROOT);
  await run("npm", ["run", "doctor"], ROOT);
}

async function assertCleanWorkingTree() {
  const output = await capture("git", ["status", "--porcelain"], ROOT);
  if (output.trim()) {
    throw new Error("Working tree has local changes. Commit, stash, or discard them before running npm run update.");
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  });
}

function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
