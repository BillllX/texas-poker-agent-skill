#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const config = await loadConfig();
  const checks = [];

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

  await checkService(config.gameUrl, checks);

  for (const item of checks) {
    console.log(`${item.ok ? "OK " : "ERR"} ${item.name}: ${item.detail}`);
  }

  if (checks.some((item) => !item.ok)) {
    process.exitCode = 1;
  }
}

async function checkService(gameUrl, checks) {
  try {
    const response = await fetch(`${gameUrl.replace(/\/$/, "")}/api/agents/onboarding`, {
      headers: { accept: "application/json" },
    });
    checks.push(check("service reachable", response.ok, `${response.status} ${gameUrl}`));
    if (response.ok) {
      const payload = await response.json();
      checks.push(check("onboarding contract", Boolean(payload.service?.healthcheckUrl), "healthcheckUrl present"));
    }
  } catch (error) {
    checks.push(check("service reachable", false, error.message));
  }
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
