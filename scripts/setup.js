#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");

const CONFIG_PATH = path.resolve(process.cwd(), "config.local.json");
const scriptedAnswers = input.isTTY ? null : fsSync.readFileSync(0, "utf8").split(/\r?\n/);
let scriptedAnswerIndex = 0;

async function main() {
  const rl = scriptedAnswers ? null : readline.createInterface({ input, output });
  try {
    const current = {
      ...(await readJson(path.resolve(__dirname, "..", "config.example.json"))),
      ...(await readJson(CONFIG_PATH)),
    };

    console.log("Texas Poker Club Agent setup");
    console.log("This writes config.local.json. Prefer environment variables for shared machines.\n");

    const config = {
      ...current,
      gameUrl: await ask(rl, "Game URL", current.gameUrl || "http://aiagentswitcher.com:3000"),
      agentId: normalizeAgentId(await ask(rl, "Agent ID, lowercase letters/numbers/hyphens", current.agentId || "openclaw-agent-01")),
      agentName: await ask(rl, "Agent display name", current.agentName || "OpenClaw Agent"),
      modelName: await ask(rl, "Model name used for real decisions", current.modelName === "replace-with-real-model-name" ? "" : current.modelName),
      agentStyle: await ask(rl, "Agent poker style", current.agentStyle || "稳健、理性、只根据当前牌局信息行动"),
      memoryPath: await ask(rl, "Local memory path", current.memoryPath || ".texas-poker-agent-memory.json"),
    };

    const provider = await choose(rl, "How should the worker call the LLM?", [
      "OpenClaw managed model via command bridge",
      "OpenClaw or local OpenAI-compatible endpoint",
      "Anthropic-compatible endpoint",
      "MiniMax endpoint",
      "Generic command bridge",
    ]);

    if (provider === 0) {
      config.llmProvider = "command";
      console.log("\nOpenClaw managed mode does not scan OpenClaw credential files.");
      console.log("Point this at a user-approved command that calls OpenClaw's configured model and prints decision JSON.");
      config.llmCommand = await ask(rl, "OpenClaw decision command", current.llmCommand || "./openclaw-decider.sh");
    } else if (provider === 1) {
      config.llmProvider = "openai-compatible";
      config.openaiCompatibleBaseUrl = await ask(rl, "OpenAI-compatible base URL", current.openaiCompatibleBaseUrl || "http://127.0.0.1:11434/v1");
      config.openaiCompatibleApiKey = await askSecretLike(rl, "OpenAI-compatible API key, use 'local' if not required", current.openaiCompatibleApiKey || "local");
    } else if (provider === 2) {
      config.llmProvider = "anthropic-compatible";
      config.anthropicCompatibleBaseUrl = await ask(rl, "Anthropic-compatible base URL", current.anthropicCompatibleBaseUrl || "https://api.example.com/v1");
      config.anthropicCompatibleApiKey = await askSecretLike(rl, "Anthropic-compatible API key", current.anthropicCompatibleApiKey || "");
    } else if (provider === 3) {
      config.llmProvider = "minimax";
      config.minimaxBaseUrl = await ask(rl, "MiniMax base URL", current.minimaxBaseUrl || "https://api.minimaxi.com/anthropic/v1");
      config.minimaxApiKey = await askSecretLike(rl, "MiniMax API key", current.minimaxApiKey || "");
    } else {
      config.llmProvider = "command";
      config.llmCommand = await ask(rl, "Decision command", current.llmCommand || "./my-agent-decider.sh");
    }

    if (!config.modelName) {
      throw new Error("Model name is required.");
    }

    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
    console.log(`\nWrote ${CONFIG_PATH}`);
    console.log("Next: npm run doctor && npm start");
  } finally {
    rl?.close();
  }
}

async function choose(rl, prompt, options) {
  console.log(prompt);
  options.forEach((option, index) => console.log(`${index + 1}. ${option}`));
  for (;;) {
    const answer = Number((await question(rl, "Choose 1-" + options.length + ": ")).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) {
      return answer - 1;
    }
    console.log("Invalid choice.");
  }
}

async function ask(rl, prompt, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await question(rl, `${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askSecretLike(rl, prompt, defaultValue = "") {
  const shownDefault = defaultValue ? mask(defaultValue) : "";
  const suffix = shownDefault ? ` [${shownDefault}]` : "";
  const answer = (await question(rl, `${prompt}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function question(rl, prompt) {
  if (scriptedAnswers) {
    const answer = scriptedAnswers[scriptedAnswerIndex++] ?? "";
    output.write(`${prompt}${answer}\n`);
    return answer;
  }
  return rl.question(prompt);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

function normalizeAgentId(value) {
  const id = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!id) {
    throw new Error("Agent ID must contain lowercase letters or numbers.");
  }
  return id;
}

function mask(value) {
  if (!value || value === "local") {
    return value;
  }
  return value.length <= 8 ? "********" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
