#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { checkForUpdates, formatUpdateNotice } = require("./version-check");

async function main() {
  const config = await loadConfig();
  const checks = [];
  const warnings = [];

  checks.push(check("node >= 18", Number(process.versions.node.split(".")[0]) >= 18, process.versions.node));
  checks.push(check("fetch available", typeof fetch === "function", "global fetch"));

  try {
    require.resolve("ws");
    checks.push(check("ws dependency", true, "installed"));
  } catch {
    checks.push(check("ws dependency", false, "run npm install"));
  }

  const agentId = normalizeAgentId(config.agentId || "example-agent");
  checks.push(check("agent id lowercase", agentId === config.agentId, config.agentId || "(missing)"));
  checks.push(check("model name configured", config.modelName && config.modelName !== "replace-with-real-model-name", config.modelName || "(missing)"));
  checks.push(check("llm provider configured", Boolean(config.llmProvider), config.llmProvider || "(missing)"));

  await checkService(config.gameUrl, checks, warnings);
  await checkSkillVersion(config.gameUrl, checks, warnings);

  for (const item of checks) {
    console.log(`${item.ok ? "OK " : "ERR"} ${item.name}: ${item.detail}`);
  }
  for (const warning of warnings) {
    console.log(`WARN ${warning}`);
  }

  if (checks.some((item) => !item.ok)) {
    process.exitCode = 1;
  }
}

async function checkService(gameUrl, checks, warnings) {
  try {
    const response = await fetch(`${gameUrl.replace(/\/$/, "")}/api/agents/onboarding`, {
      headers: { accept: "application/json" },
    });
    checks.push(check("service reachable", response.ok, `${response.status} ${gameUrl}`));
    if (response.ok) {
      const payload = await response.json();
      checks.push(check("onboarding contract", Boolean(payload.service?.healthcheckUrl), "healthcheckUrl present"));
      if (payload.skill?.repositoryUrl) {
        checks.push(check("skill recommendation", true, payload.skill.repositoryUrl));
      } else {
        warnings.push("Service did not provide skill recommendation metadata yet.");
      }
    }
  } catch (error) {
    checks.push(check("service reachable", false, error.message));
  }
}

async function checkSkillVersion(gameUrl, checks, warnings) {
  const status = await checkForUpdates({ gameUrl, fetchRemote: true });
  checks.push(check("skill git repository", status.isGitRepo, status.isGitRepo ? (status.currentCommit || "").slice(0, 12) : "not a git checkout"));
  const notice = formatUpdateNotice(status);
  if (notice) {
    warnings.push(notice);
  }
  warnings.push(...status.warnings);
}

async function loadConfig() {
  const example = await readJson(path.resolve(__dirname, "..", "config.example.json"));
  const local = await readJson(path.resolve(process.cwd(), "config.local.json"));
  return {
    ...example,
    ...local,
    gameUrl: process.env.GAME_URL || local.gameUrl || example.gameUrl,
    agentId: process.env.AGENT_ID || local.agentId || example.agentId,
    modelName: process.env.MODEL_NAME || local.modelName || example.modelName,
    llmProvider: process.env.LLM_PROVIDER || local.llmProvider || example.llmProvider,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

function normalizeAgentId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
