#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const path = require("node:path");

const DEFAULT_REMOTE = "origin";
const DEFAULT_BRANCH = "main";

async function checkForUpdates(options = {}) {
  const root = options.root || path.resolve(__dirname, "..");
  const remote = options.remote || DEFAULT_REMOTE;
  const branch = options.branch || DEFAULT_BRANCH;
  const result = {
    isGitRepo: false,
    currentCommit: null,
    remoteCommit: null,
    ahead: 0,
    behind: 0,
    serviceRecommendedCommit: null,
    serviceRecommendedRef: null,
    warnings: [],
  };

  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    result.isGitRepo = true;
    result.currentCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  } catch {
    result.warnings.push("Skill directory is not a git repository; automatic version checks are unavailable.");
    return result;
  }

  if (options.fetchRemote !== false) {
    try {
      await git(root, ["fetch", "--quiet", remote, branch]);
    } catch (error) {
      result.warnings.push(`Could not fetch ${remote}/${branch}: ${shortError(error)}`);
    }
  }

  try {
    result.remoteCommit = (await git(root, ["rev-parse", `${remote}/${branch}`])).trim();
    const counts = (await git(root, ["rev-list", "--left-right", "--count", `HEAD...${remote}/${branch}`])).trim().split(/\s+/);
    result.ahead = Number(counts[0] || 0);
    result.behind = Number(counts[1] || 0);
  } catch (error) {
    result.warnings.push(`Could not compare against ${remote}/${branch}: ${shortError(error)}`);
  }

  if (options.gameUrl) {
    try {
      const onboarding = await fetchOnboarding(options.gameUrl);
      result.serviceRecommendedCommit = onboarding.skill?.recommendedCommit || null;
      result.serviceRecommendedRef = onboarding.skill?.recommendedRef || null;
    } catch (error) {
      result.warnings.push(`Could not read service skill recommendation: ${error.message}`);
    }
  }

  return result;
}

function hasUpdate(result) {
  return result.behind > 0 || Boolean(result.serviceRecommendedCommit && result.currentCommit !== result.serviceRecommendedCommit);
}

function formatUpdateNotice(result) {
  if (!result.isGitRepo) {
    return null;
  }
  if (result.behind > 0) {
    return `A newer Texas Poker Agent Skill is available (${result.behind} commit(s) behind origin/main). Run: npm run update`;
  }
  if (result.serviceRecommendedCommit && result.currentCommit !== result.serviceRecommendedCommit) {
    return `The game service recommends skill commit ${result.serviceRecommendedCommit.slice(0, 12)}. Current commit is ${result.currentCommit?.slice(0, 12) || "unknown"}. Run: npm run update`;
  }
  return null;
}

async function fetchOnboarding(gameUrl) {
  const response = await fetch(`${gameUrl.replace(/\/$/, "")}/api/agents/onboarding`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`onboarding returned ${response.status}`);
  }
  return response.json();
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function shortError(error) {
  return String(error.stderr || error.message || error).trim().split("\n")[0];
}

module.exports = {
  checkForUpdates,
  formatUpdateNotice,
  hasUpdate,
};
