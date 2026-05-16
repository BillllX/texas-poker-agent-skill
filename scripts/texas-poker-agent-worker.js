#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { checkForUpdates, formatUpdateNotice } = require("./version-check");

const DECISION_SAFETY_MS = 20_000;
const RECONNECT_MS = 3_000;

let settings;
let socket;
let stopping = false;
const inFlightRequestIds = new Set();
const submittedRequestIds = new Set();

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});

async function main() {
  settings = await loadSettings();
  validateSettings(settings);
  checkSkillVersionInBackground(settings.gameUrl);

  const owner = await loadOrRegisterUser();
  const healthcheck = await runHealthcheck(owner);

  if (healthcheck.nextAction === "open_websocket" || healthcheck.nextAction === "already_connected") {
    console.log("[healthcheck]", healthcheck.nextAction, "skipping qualification");
  } else {
    const qualificationToken =
      healthcheck.nextAction === "register_agent" && healthcheck.issuedQualificationToken?.token
        ? healthcheck.issuedQualificationToken.token
        : (await runQualification()).qualificationToken;
    await registerAgent(owner, qualificationToken);
  }

  await publishProfileHtml(owner);
  connectWebSocket();
  installShutdownHandlers();
}

function checkSkillVersionInBackground(gameUrl) {
  if (process.env.SKILL_UPDATE_CHECK === "0") {
    return;
  }
  void checkForUpdates({ gameUrl, fetchRemote: false })
    .then((status) => {
      const notice = formatUpdateNotice(status);
      if (notice) {
        console.warn("[skill:update]", notice);
      }
    })
    .catch((error) => {
      console.warn("[skill:update] version check skipped:", error.message);
    });
}

async function loadSettings() {
  const example = await readJson(path.resolve(__dirname, "..", "config.example.json"));
  const local = await readJson(path.resolve(process.cwd(), "config.local.json"));
  const merged = { ...example, ...local };

  return {
    gameUrl: env("GAME_URL", merged.gameUrl).replace(/\/$/, ""),
    agentId: normalizeAgentId(env("AGENT_ID", merged.agentId)),
    agentName: env("AGENT_NAME", merged.agentName),
    modelName: env("MODEL_NAME", merged.modelName),
    agentStyle: env("AGENT_STYLE", merged.agentStyle),
    strategyPath: path.resolve(process.cwd(), env("AGENT_STRATEGY_PATH", env("STRATEGY_PATH", merged.strategyPath))),
    profileHtmlPath: path.resolve(process.cwd(), env("PROFILE_HTML_PATH", merged.profileHtmlPath)),
    llmProvider: env("LLM_PROVIDER", merged.llmProvider),
    memoryPath: path.resolve(process.cwd(), env("MEMORY_PATH", merged.memoryPath)),
    openaiCompatibleBaseUrl: env("OPENAI_COMPATIBLE_BASE_URL", merged.openaiCompatibleBaseUrl).replace(/\/$/, ""),
    openaiCompatibleApiKey: env("OPENAI_COMPATIBLE_API_KEY", merged.openaiCompatibleApiKey),
    anthropicCompatibleBaseUrl: env("ANTHROPIC_COMPATIBLE_BASE_URL", merged.anthropicCompatibleBaseUrl).replace(/\/$/, ""),
    anthropicCompatibleApiKey: env("ANTHROPIC_COMPATIBLE_API_KEY", merged.anthropicCompatibleApiKey),
    minimaxBaseUrl: env("MINIMAX_BASE_URL", merged.minimaxBaseUrl).replace(/\/$/, ""),
    minimaxApiKey: env("MINIMAX_API_KEY", merged.minimaxApiKey),
    llmCommand: env("LLM_COMMAND", merged.llmCommand),
    maxTokens: Number(env("LLM_MAX_TOKENS", "1800")),
    timeoutMs: Number(env("LLM_TIMEOUT_MS", "120000")),
  };
}

function validateSettings(value) {
  if (!value.agentId) {
    throw new Error("Set AGENT_ID to lowercase letters, numbers, and hyphens.");
  }
  if (!value.modelName || value.modelName === "replace-with-real-model-name") {
    throw new Error("Set MODEL_NAME to the exact LLM model used for decisions.");
  }
  if (!["openai-compatible", "anthropic-compatible", "minimax", "command"].includes(value.llmProvider)) {
    throw new Error("Set LLM_PROVIDER to openai-compatible, anthropic-compatible, minimax, or command.");
  }
}

async function loadOrRegisterUser() {
  const memory = {
    ...(await readJson(settings.memoryPath)),
    ownerUserId: process.env.OWNER_USER_ID || undefined,
    userToken: process.env.USER_TOKEN || undefined,
  };

  if (memory.ownerUserId && memory.userToken) {
    console.log("[user] using ownerUserId:", memory.ownerUserId);
    return memory;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const name = (await rl.question("Choose a Texas Poker Club user name: ")).trim();
    const email = (await rl.question("Enter Email for daily Token rewards: ")).trim();

    const nameCheck = await getJson(`/api/users/check-name?name=${encodeURIComponent(name)}`);
    if (!nameCheck.available) {
      throw new Error(`User name is not available: ${name}`);
    }

    const captcha = await getJson("/api/users/captcha");
    const captchaAnswer = (await rl.question(`Captcha: ${captcha.challenge} `)).trim();
    const payload = await postJson("/api/users", {
      name,
      email,
      captchaId: captcha.captchaId,
      captchaAnswer,
    });

    const credentials = {
      ownerUserId: payload.user.id,
      userName: payload.user.name,
      userToken: payload.userToken,
      email,
    };
    await writeJson(settings.memoryPath, credentials);
    console.log("[user] saved ownerUserId/userToken to local memory:", credentials.ownerUserId);
    return credentials;
  } finally {
    rl.close();
  }
}

async function runHealthcheck(owner) {
  const healthcheck = await postJson("/api/agents/healthcheck", {
    agentId: settings.agentId,
    modelName: settings.modelName,
    ownerUserId: owner.ownerUserId,
    userToken: owner.userToken,
  });

  console.log("[healthcheck]", healthcheck.nextAction);
  if (healthcheck.nextAction === "register_agent" && healthcheck.issuedQualificationToken?.token) {
    console.log("[healthcheck] reusing persisted qualification token");
  }

  const expected = ["run_qualification", "register_agent", "open_websocket", "already_connected"];
  if (!expected.includes(healthcheck.nextAction)) {
    throw new Error(`Healthcheck requires manual action: ${healthcheck.nextAction} ${JSON.stringify(healthcheck.issues || [])}`);
  }
  return healthcheck;
}

async function runQualification() {
  console.log("[qualification] fetching fresh tasks");
  const qualification = await getJson(`/api/agents/qualification/tasks?agentId=${encodeURIComponent(settings.agentId)}`);
  const responses = [];

  for (const task of qualification.tasks || []) {
    const action =
      task.qualificationCase?.mode === "format_only"
        ? normalizeAction(task.qualificationCase.requiredAction, task.legalActions)
        : (await decideWithLlmOrFallback(task, { isQualification: true })).action;

    responses.push({
      caseId: task.qualificationCase.caseId,
      response: {
        type: "action_response",
        requestId: task.requestId,
        playerId: task.playerId,
        action,
        reasoning:
          task.qualificationCase?.mode === "format_only"
            ? `格式自检：按要求输出 ${action.type} 动作。`
            : "模型基于资格测试牌局输出合法动作。",
      },
    });
  }

  await runQualificationSandbox(qualification);

  const result = await postJson("/api/agents/qualification/submit", {
    agentId: qualification.agentId,
    qualificationId: qualification.qualificationId,
    responses,
  });
  console.log("[qualification] passed");
  return result;
}

async function runQualificationSandbox(qualification) {
  const wsUrl = `${wsBaseUrl()}/api/agents/qualification/ws?agentId=${encodeURIComponent(qualification.agentId)}&qualificationId=${encodeURIComponent(qualification.qualificationId)}`;
  console.log("[qualification:ws] connecting", wsUrl);

  await new Promise((resolve, reject) => {
    const sandbox = new WebSocket(wsUrl);
    const submitted = new Set();
    const timer = setTimeout(() => {
      sandbox.close();
      reject(new Error("WebSocket qualification timed out."));
    }, 35_000);

    sandbox.on("open", () => console.log("[qualification:ws] open"));
    sandbox.on("error", reject);
    sandbox.on("message", (raw) => {
      void (async () => {
        const payload = JSON.parse(raw.toString());
        if (["ws_welcome", "table_assigned", "heartbeat"].includes(payload.type)) {
          console.log("[qualification:ws]", payload.type, payload.tableUrl || "");
          return;
        }
        if (payload.type === "action_ack") {
          console.log("[qualification:ws] ack", payload.requestId);
          return;
        }
        if (payload.type === "action_error") {
          if (payload.recoverable) {
            console.warn("[qualification:ws] recoverable", payload.code || "", payload.error);
            return;
          }
          throw new Error(payload.error || "WebSocket qualification action_error.");
        }
        if (payload.type === "decision_task") {
          const request = payload.task?.request;
          if (!request || submitted.has(request.requestId)) {
            return;
          }
          const decision = await decideWithLlmOrFallback(request, { isQualification: true });
          submitted.add(request.requestId);
          sandbox.send(JSON.stringify(actionResponse(request, decision.action, decision.reasoning)));
          return;
        }
        if (payload.type === "agent_stop") {
          clearTimeout(timer);
          if (!payload.shouldStop || !payload.ok) {
            throw new Error(payload.reason || "WebSocket qualification stopped before passing.");
          }
          console.log("[qualification:ws] passed");
          sandbox.close(1000, "qualification passed");
          resolve(undefined);
          return;
        }
        console.log("[qualification:ws] ignored", payload.type);
      })().catch((error) => {
        clearTimeout(timer);
        sandbox.close();
        reject(error);
      });
    });
  });
}

async function registerAgent(owner, qualificationToken) {
  console.log("[roster] registering", settings.agentId);
  await postJson("/api/agents/roster", {
    id: settings.agentId,
    name: settings.agentName,
    modelName: settings.modelName,
    ownerUserId: owner.ownerUserId,
    userToken: owner.userToken,
    qualificationToken,
  });
  console.log("[roster] registered");
}

async function publishProfileHtml(owner) {
  const html = (await readText(settings.profileHtmlPath)).trim();
  if (!html) {
    return;
  }

  console.log("[profile] publishing custom profile html");
  const result = await postJson(`/api/agents/${encodeURIComponent(settings.agentId)}/profile-html`, {
    ownerUserId: owner.ownerUserId,
    userToken: owner.userToken,
    html,
  });

  if (result.profileHtml?.updatedAt) {
    console.log("[profile] custom profile html updated", result.profileHtml.updatedAt);
  } else {
    console.log("[profile] custom profile html updated");
  }
}

function connectWebSocket() {
  const wsUrl = `${wsBaseUrl()}/api/agents/ws?agentId=${encodeURIComponent(settings.agentId)}`;
  console.log("[ws] connecting", wsUrl);
  socket = new WebSocket(wsUrl);

  socket.on("open", () => console.log("[ws] open"));
  socket.on("message", (raw) => {
    void handleSocketMessage(JSON.parse(raw.toString())).catch((error) => {
      console.error("[ws] message handling failed", error);
    });
  });
  socket.on("close", (code, reason) => {
    console.log("[ws] closed", code, reason.toString());
    if (!stopping) {
      setTimeout(connectWebSocket, RECONNECT_MS);
    }
  });
  socket.on("error", (error) => console.error("[ws] error", error.message));
}

async function handleSocketMessage(payload) {
  if (["ws_welcome", "heartbeat", "queue_status", "table_assigned", "table_settled"].includes(payload.type)) {
    const tableUrl = payload.tableUrl || payload.previousTableUrl || "";
    console.log("[ws]", payload.type, tableUrl || payload.tableId || payload.previousTableId || "");
    if (tableUrl) {
      console.log("[table] watch your Agent here:", tableUrl);
    }
    return;
  }
  if (payload.type === "action_ack") {
    console.log("[action] ack", payload.requestId);
    return;
  }
  if (payload.type === "action_error") {
    console.warn("[action] error", payload.code || "", payload.error || "");
    return;
  }
  if (payload.type === "agent_stop") {
    console.log("[ws] agent_stop", payload.reason || "");
    stopping = true;
    socket?.close();
    return;
  }
  if (payload.type === "decision_task" && payload.task?.request) {
    if (payload.tableUrl) {
      console.log("[table] watch your Agent here:", payload.tableUrl);
    }
    await handleDecisionTask(payload.task);
    return;
  }
  console.log("[ws] ignored message", payload.type);
}

async function handleDecisionTask(task) {
  const request = task.request;
  if (submittedRequestIds.has(request.requestId) || inFlightRequestIds.has(request.requestId)) {
    console.log("[decision] duplicate request ignored", request.requestId);
    return;
  }

  const msLeft = new Date(task.expiresAt).getTime() - Date.now();
  if (Number.isFinite(msLeft) && msLeft <= DECISION_SAFETY_MS) {
    return sendAction(request, failureAction(request.legalActions), "剩余时间不足，按规则提交保守动作。");
  }

  inFlightRequestIds.add(request.requestId);
  try {
    const runtimeInstructions = await fetchRuntimeInstructions();
    const deadlineMs = Number.isFinite(msLeft) ? Math.max(1_000, msLeft - DECISION_SAFETY_MS) : settings.timeoutMs;
    const decision = await withDeadline(
      decideWithLlmOrFallback(request, { runtimeInstructions, isQualification: false }),
      deadlineMs,
    ).catch(() => fallback("模型调用超时。", request.legalActions));

    sendAction(request, decision.action, decision.reasoning);
  } finally {
    inFlightRequestIds.delete(request.requestId);
  }
}

async function decideWithLlmOrFallback(request, context = {}) {
  try {
    const currentAgentStyle = await loadCurrentAgentStyle();
    const promptContext = { ...context, agentStyle: currentAgentStyle };
    const prompt = buildPrompt(request, promptContext);
    const modelDecision = await callConfiguredLlm(prompt, { request, context: promptContext });
    const decision = normalizeDecision(modelDecision, request.legalActions || []);
    if (!decision) {
      return fallback("模型输出动作不合法。", request.legalActions || []);
    }
    return decision;
  } catch (error) {
    return fallback(`模型调用失败：${error instanceof Error ? error.message : "unknown"}。`, request.legalActions || []);
  }
}

function sendAction(request, action, reasoning) {
  if (submittedRequestIds.has(request.requestId)) {
    console.log("[action] duplicate submit ignored", request.requestId);
    return;
  }

  const response = actionResponse(request, action, reasoning);
  console.log("[action] submit", JSON.stringify(response));
  submittedRequestIds.add(request.requestId);
  socket.send(JSON.stringify(response));
}

function actionResponse(request, action, reasoning) {
  return {
    type: "action_response",
    requestId: request.requestId,
    tableId: request.tableId,
    playerId: request.playerId,
    action,
    reasoning,
  };
}

async function leaveGame() {
  stopping = true;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "agent_leave", agentId: settings.agentId }));
  } else {
    const memory = await readJson(settings.memoryPath);
    if (memory.userToken) {
      await postJson("/api/agents/leave", { agentId: settings.agentId, userToken: memory.userToken });
    }
  }
}

function installShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      console.log("[shutdown]", signal);
      void leaveGame().finally(() => setTimeout(() => process.exit(0), 500));
    });
  }
}

async function fetchRuntimeInstructions() {
  try {
    return await getJson(`/api/agents/runtime-instructions?agentId=${encodeURIComponent(settings.agentId)}`);
  } catch {
    return { instructions: [] };
  }
}

async function loadCurrentAgentStyle() {
  const fileStrategy = await readText(settings.strategyPath);
  if (fileStrategy.trim()) {
    return fileStrategy.trim();
  }

  const local = await readJson(path.resolve(process.cwd(), "config.local.json"));
  if (typeof local.agentStyle === "string" && local.agentStyle.trim()) {
    return local.agentStyle.trim();
  }

  return settings.agentStyle;
}

function buildPrompt(request, context) {
  const publicState = request.publicState || {};
  const decisionInput = {
    privateCards: request.privateCards || [],
    communityCards: publicState.communityCards || [],
    phase: publicState.phase,
    pot: publicState.pot,
    currentBet: publicState.currentBet,
    toCall: request.toCall,
    minRaise: request.minRaise,
    stack: request.stack,
    legalActions: request.legalActions || [],
    players: publicState.players || [],
    recentActionHistory: request.actionHistory || [],
  };

  return `
You are playing no-limit Texas Hold'em as ${request.playerId}.
Agent style:
${context.agentStyle || settings.agentStyle}
Model name: ${settings.modelName}

Return exactly one JSON object and nothing else.
No Markdown. No code fences. No comments.
The reasoning field must be concise.
Use only facts in the request. Do not invent opponent hole cards, prior hands, player tendencies, or unavailable actions.

Current legalActions for this exact decision:
${JSON.stringify(request.legalActions || [])}

Required JSON schema:
{"action":{"type":"fold|check|call|bet|raise","amount":number_if_and_only_if_bet_or_raise},"reasoning":"brief explanation"}

General action shapes:
- fold:  {"type":"fold"}
- check: {"type":"check"}
- call:  {"type":"call"}
- bet:   {"type":"bet","amount": positive_number}
- raise: {"type":"raise","amount": positive_number}

Only choose action.type from legalActions.
Never include amount for fold/check/call. Call is exactly {"type":"call"}, even when toCall is greater than 0.
If legalActions includes call, {"type":"call"} is legal even when toCall is greater than stack; it becomes a short-stack all-in call for the remaining stack. Do not fold only because stack is smaller than toCall.
For raise, amount is the target total bet for this betting round and should be at least currentBet + minRaise.
Opponent hole cards are not available. Use only privateCards as your own cards.

Runtime instructions:
${JSON.stringify(context.runtimeInstructions?.instructions || [])}

Decision input:
${JSON.stringify(decisionInput)}
`;
}

async function callConfiguredLlm(prompt, context) {
  if (settings.llmProvider === "openai-compatible") {
    return callOpenAiCompatible(prompt);
  }
  if (settings.llmProvider === "anthropic-compatible") {
    return callAnthropicCompatible(prompt);
  }
  if (settings.llmProvider === "minimax") {
    return callMiniMax(prompt);
  }
  if (settings.llmProvider === "command") {
    return callCommandProvider(prompt, context);
  }
  throw new Error(`Unsupported LLM_PROVIDER: ${settings.llmProvider}`);
}

async function callOpenAiCompatible(prompt) {
  const response = await fetch(`${settings.openaiCompatibleBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.openaiCompatibleApiKey || "local"}`,
    },
    body: JSON.stringify({
      model: settings.modelName,
      temperature: 0.7,
      max_tokens: settings.maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return parseModelJson(data.choices?.[0]?.message?.content || "");
}

async function callAnthropicCompatible(prompt) {
  try {
    return parseModelJson(extractTextFromAnthropic(await requestAnthropicCompatible(prompt), "anthropic-compatible"));
  } catch (error) {
    console.warn("[llm] anthropic-compatible parse failed; retrying once with thinking disabled:", error.message);
    return parseModelJson(extractTextFromAnthropic(await requestAnthropicCompatible(prompt), "anthropic-compatible-retry"));
  }
}

async function requestAnthropicCompatible(prompt) {
  const body = {
    model: settings.modelName,
    max_tokens: settings.maxTokens,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: prompt }],
  };

  const response = await fetch(`${settings.anthropicCompatibleBaseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": settings.anthropicCompatibleApiKey,
      authorization: `Bearer ${settings.anthropicCompatibleApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Anthropic-compatible request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function callMiniMax(prompt) {
  try {
    return parseModelJson(extractTextFromAnthropic(await requestMiniMax(prompt), "minimax"));
  } catch (error) {
    console.warn("[llm] minimax parse failed; retrying once with strict JSON reminder:", error.message);
    return parseModelJson(extractTextFromAnthropic(await requestMiniMax(withStrictJsonReminder(prompt)), "minimax-retry"));
  }
}

async function requestMiniMax(prompt) {
  const response = await fetch(`${settings.minimaxBaseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": settings.minimaxApiKey,
      authorization: `Bearer ${settings.minimaxApiKey}`,
    },
    body: JSON.stringify({
      model: settings.modelName,
      max_tokens: settings.maxTokens,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`MiniMax request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function callCommandProvider(prompt, context) {
  if (!settings.llmCommand) {
    throw new Error("Set LLM_COMMAND when LLM_PROVIDER=command.");
  }

  const inputPayload = JSON.stringify({
    prompt,
    request: context.request,
    runtimeInstructions: context.context?.runtimeInstructions || {},
    agentStyle: context.context?.agentStyle || settings.agentStyle,
  });

  const outputText = await new Promise((resolve, reject) => {
    const child = spawn(settings.llmCommand, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutText = "";
    let stderrText = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("LLM command timed out."));
    }, settings.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutText += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderrText += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`LLM command exited ${code}: ${stderrText}`));
        return;
      }
      resolve(stdoutText);
    });
    child.stdin.end(inputPayload);
  });

  return parseModelJson(outputText);
}

function extractTextFromAnthropic(data, label = "anthropic-compatible") {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) {
    debugAnthropicExtraction(label, blocks, "using text block");
    return text;
  }

  debugAnthropicExtraction(label, blocks, "no text block; checking thinking block");
  const thinking = blocks
    .filter((block) => block?.type === "thinking")
    .map((block) => block.text || block.thinking || "")
    .join("\n");
  const match = thinking.match(/\{[\s\S]*\}/);
  if (match) {
    return match[0];
  }
  if (thinking.trim()) {
    return thinking;
  }
  debugAnthropicExtraction(label, blocks, "no text or thinking content");
  throw new Error("Model response did not contain text JSON.");
}

function debugAnthropicExtraction(label, blocks, reason) {
  const summary = blocks.map((block) => ({
    type: block?.type || "unknown",
    textLength: typeof block?.text === "string" ? block.text.length : 0,
    thinkingLength: typeof block?.thinking === "string" ? block.thinking.length : 0,
  }));
  const message = `[llm:${label}] ${reason}; content blocks: ${JSON.stringify(summary)}`;
  if (process.env.LLM_DEBUG === "1" || reason !== "using text block") {
    console.warn(message);
  }
}

function withStrictJsonReminder(prompt) {
  return `${prompt}

The previous response did not contain parseable JSON.
Return exactly one JSON object with this shape and no other text:
{"action":{"type":"fold|check|call|bet|raise"},"reasoning":"brief explanation"}`;
}

function parseModelJson(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() || trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Model response did not contain JSON.");
    }
    return JSON.parse(match[0]);
  }
}

function normalizeDecision(modelDecision, legalActions) {
  const actionSource = modelDecision?.action && typeof modelDecision.action === "object" ? modelDecision.action : modelDecision;
  const action = normalizeAction(actionSource, legalActions);
  if (!action) {
    return null;
  }

  const reasoning =
    typeof modelDecision?.reasoning === "string" && modelDecision.reasoning.trim()
      ? modelDecision.reasoning.trim()
      : typeof actionSource?.reasoning === "string" && actionSource.reasoning.trim()
        ? actionSource.reasoning.trim()
        : "模型基于当前牌局状态选择该合法动作。";

  return { action, reasoning };
}

function normalizeAction(action, legalActions) {
  if (!action || !legalActions.includes(action.type)) {
    return null;
  }
  if (action.type === "bet" || action.type === "raise") {
    const amount = Number(action.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    return { type: action.type, amount };
  }
  return { type: action.type };
}

function fallback(reason, legalActions) {
  return {
    action: failureAction(legalActions),
    reasoning: legalActions.includes("fold") ? `${reason} 按规则直接弃牌。` : `${reason} fold 不可用，按规则过牌。`,
  };
}

function failureAction(legalActions) {
  return legalActions.includes("fold") ? { type: "fold" } : { type: "check" };
}

async function getJson(pathname) {
  const response = await fetch(`${settings.gameUrl}${pathname}`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function postJson(pathname, body) {
  const response = await fetch(`${settings.gameUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

function normalizeAgentId(value) {
  const id = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!id) {
    throw new Error("AGENT_ID must contain lowercase letters or numbers.");
  }
  return id;
}

function wsBaseUrl() {
  return settings.gameUrl.replace(/^http/, "ws");
}

function env(name, fallbackValue) {
  return process.env[name] ?? fallbackValue ?? "";
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LLM decision deadline exceeded.")), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
