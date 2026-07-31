const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

const ENV_FILE = ".env.local";
const STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";
const QUANTITY = 10;
const TEST_SESSION_DURATION_MS = 60 * 1000;
const REGULAR_OPEN_HOUR = 9;
const REGULAR_OPEN_MINUTE = 30;
const OPENING_SESSION_END_HOUR = 9;
const OPENING_SESSION_END_MINUTE = 40;
const PANEL_INTERVAL_MS = 500;
const STEP_TIMEOUT_MS = 10 * 1000;
const CLOSE_TIMEOUT_MS = 5 * 1000;
const MAX_RECENT_EVENTS = 6;
const ENTRY_DRAWDOWN_PCT = 5;
const MARKET_TIME_ZONE = "America/New_York";
const marketTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const marketOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TIME_ZONE,
  timeZoneName: "longOffset",
});

function createFailure(stage, message, details = {}) {
  const error = new Error(message);
  error.stage = stage;
  Object.assign(error, details);
  return error;
}

function readSymbols() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length === 0) {
    throw createFailure(
      "COMMAND",
      "Usage: node alopMulti.js NVDA [TSLA AMD MSFT AAPL]",
    );
  }

  const symbols = [];
  const seen = new Set();
  for (const argument of argumentsList) {
    const symbol = argument.trim().toUpperCase();
    if (!symbol || !/^[A-Z][A-Z0-9.-]*$/.test(symbol)) {
      throw createFailure(
        "COMMAND",
        `Invalid symbol: ${argument || "(empty)"}.`,
      );
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      symbols.push(symbol);
    }
  }

  if (symbols.length > 5) {
    throw createFailure(
      "COMMAND",
      `At most 5 unique symbols are allowed; received ${symbols.length}.`,
    );
  }
  return symbols;
}

function loadCredentials() {
  if (typeof process.loadEnvFile !== "function") {
    throw createFailure(
      "CONFIGURATION",
      "process.loadEnvFile() is unavailable.",
    );
  }

  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    throw createFailure(
      "CONFIGURATION",
      `Could not load ${ENV_FILE}: ${error.message}`,
    );
  }

  if (!process.env.ALPACA_API_KEY_ID?.trim()) {
    throw createFailure(
      "CONFIGURATION",
      `ALPACA_API_KEY_ID is missing from ${ENV_FILE}.`,
    );
  }
  if (!process.env.ALPACA_API_SECRET_KEY?.trim()) {
    throw createFailure(
      "CONFIGURATION",
      `ALPACA_API_SECRET_KEY is missing from ${ENV_FILE}.`,
    );
  }
}

function validateOpeningMode(openingMode) {
  if (!["OPENING", "POST-OPENING", "TEST"].includes(openingMode)) {
    throw createFailure(
      "CONFIGURATION",
      `Invalid operating mode: ${openingMode}.`,
    );
  }
}

async function selectOperatingMode() {
  const prompt = [
    "",
    "-------------------------------------",
    "",
    "Select operating mode",
    "",
    "A - OPENING",
    "    Wait for the real market opening.",
    "",
    "B - POST-OPENING",
    "    Analytical mode.",
    "    Use the first received trade as opening reference.",
    "    Run until Ctrl+C.",
    "",
    "C - TEST",
    "    Quick 60-second live market test.",
    "    Uses the first received trade as reference.",
    "",
    "Choice: ",
  ].join("\n");
  const modes = {
    A: "OPENING",
    B: "POST-OPENING",
    C: "TEST",
  };
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  process.stdout.write("\x07");
  try {
    while (true) {
      const choice = (await terminal.question(prompt)).trim().toUpperCase();
      if (modes[choice]) {
        const openingMode = modes[choice];
        const processStartedAt = Date.now();
        if (
          openingMode === "OPENING" &&
          !isBeforeRegularOpen(processStartedAt)
        ) {
          process.stdout.write("\x07");
          process.stdout.write(
            [
              "",
              "-------------------------------------",
              "",
              "The regular market has already opened.",
              "",
              "OPENING mode is no longer available.",
              "",
              "Please choose:",
              "",
              "B - POST-OPENING",
              "",
              "or",
              "",
              "C - TEST",
              "",
              "-------------------------------------",
              "",
            ].join("\n"),
          );
          continue;
        }
        process.stdout.write("\n-------------------------------------\n");
        return { openingMode, processStartedAt };
      }
      process.stdout.write("\nInvalid choice. Enter A, B, or C.\n");
    }
  } finally {
    terminal.close();
  }
}

function localRunTimestamp(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function createRunLogs() {
  const logsRoot = path.resolve("logs");
  fs.mkdirSync(logsRoot, { recursive: true });

  const baseName = localRunTimestamp();
  let runDirectory = path.join(logsRoot, baseName);
  let suffix = 2;
  while (fs.existsSync(runDirectory)) {
    runDirectory = path.join(logsRoot, `${baseName}_${suffix}`);
    suffix += 1;
  }
  fs.mkdirSync(runDirectory);

  const eventsPath = path.join(runDirectory, "events.log");
  const pricesPath = path.join(runDirectory, "prices.csv");
  const eventsStream = fs.createWriteStream(eventsPath, { flags: "wx" });
  const pricesStream = fs.createWriteStream(pricesPath, { flags: "wx" });

  await Promise.all([
    new Promise((resolve, reject) => {
      eventsStream.once("open", resolve);
      eventsStream.once("error", reject);
    }),
    new Promise((resolve, reject) => {
      pricesStream.once("open", resolve);
      pricesStream.once("error", reject);
    }),
  ]);

  pricesStream.write(
    "received_at,trade_timestamp,symbol,price,size,trade_id,exchange,conditions\n",
  );

  return {
    runDirectory,
    eventsPath,
    pricesPath,
    eventsStream,
    pricesStream,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function marketTimeParts(timestampMs) {
  return Object.fromEntries(
    marketTimeFormatter
      .formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function marketSecondsSinceMidnight(parts) {
  return (
    Number(parts.hour) * 60 * 60 +
    Number(parts.minute) * 60 +
    Number(parts.second)
  );
}

function isBeforeRegularOpen(timestampMs) {
  const regularOpen =
    REGULAR_OPEN_HOUR * 60 * 60 + REGULAR_OPEN_MINUTE * 60;
  return marketSecondsSinceMidnight(marketTimeParts(timestampMs)) < regularOpen;
}

function marketClockTimestamp(timestampMs, hour, minute) {
  const parts = marketTimeParts(timestampMs);
  const offsetName = marketOffsetFormatter
    .formatToParts(new Date(timestampMs))
    .find((part) => part.type === "timeZoneName")?.value;
  const offsetMatch = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offsetName ?? "");
  if (!offsetMatch) {
    throw createFailure(
      "CONFIGURATION",
      `Could not determine ${MARKET_TIME_ZONE} UTC offset.`,
    );
  }

  const offsetSign = offsetMatch[1] === "+" ? 1 : -1;
  const offsetMinutes =
    offsetSign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  return (
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      hour,
      minute,
    ) -
    offsetMinutes * 60 * 1000
  );
}

function regularOpenTimestamp(timestampMs) {
  return marketClockTimestamp(
    timestampMs,
    REGULAR_OPEN_HOUR,
    REGULAR_OPEN_MINUTE,
  );
}

function openingSessionEndTimestamp(timestampMs) {
  return marketClockTimestamp(
    timestampMs,
    OPENING_SESSION_END_HOUR,
    OPENING_SESSION_END_MINUTE,
  );
}

function isRegularSessionTrade(timestampMs) {
  const parts = marketTimeParts(timestampMs);
  if (["Sat", "Sun"].includes(parts.weekday)) {
    return false;
  }

  const secondsSinceMidnight = marketSecondsSinceMidnight(parts);
  const regularOpen =
    REGULAR_OPEN_HOUR * 60 * 60 + REGULAR_OPEN_MINUTE * 60;
  const regularClose = 16 * 60 * 60;
  return (
    secondsSinceMidnight >= regularOpen &&
    secondsSinceMidnight < regularClose
  );
}

function acceptsOpeningTrade(
  openingCanBeDetermined,
  operationalSessionStarted,
  timestampMs,
  openingMode,
) {
  return (
    openingMode === "TEST" ||
    (openingCanBeDetermined &&
      operationalSessionStarted &&
      isRegularSessionTrade(timestampMs))
  );
}

function formatDuration(durationMs) {
  if (durationMs > 60 * 1000 && durationMs % (60 * 1000) === 0) {
    return `${durationMs / (60 * 1000)}m`;
  }
  return `${durationMs / 1000}s`;
}

function compactMarketTimestamp(timestamp) {
  if (timestamp === null) {
    return "-";
  }

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return "-";
  }

  const parts = marketTimeParts(timestampMs);
  const tenths = Math.floor(new Date(timestampMs).getUTCMilliseconds() / 100);
  return `${parts.hour}:${parts.minute}:${parts.second}.${tenths}`;
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
    stream.end();
  });
}

async function closeRunLogs(logs) {
  await Promise.all([
    closeWriteStream(logs.eventsStream),
    closeWriteStream(logs.pricesStream),
  ]);
}

function runMarketDataSession(
  symbols,
  logs,
  processStartedAt,
  {
    WebSocketImpl = globalThis.WebSocket,
    openingMode,
    testSessionDurationMs = TEST_SESSION_DURATION_MS,
    renderOutput = true,
  } = {},
) {
  validateOpeningMode(openingMode);
  return new Promise((resolve, reject) => {
    const states = new Map(
      symbols.map((symbol) => [
        symbol,
        {
          symbol,
          quantity: QUANTITY,
          lastPrice: null,
          tradeCount: 0,
          firstTimestamp: null,
          lastTimestamp: null,
          openingPrice: null,
          openingTimestamp: null,
          lowestPrice: null,
          lowestTimestamp: null,
          drawdownPercent: null,
          armedTimestamp: null,
          triggerTimestamp: null,
          state: "WAITING_OPEN",
        },
      ]),
    );
    const recentEvents = [];

    let socket;
    let stage = "CONNECTING";
    let phaseTimer;
    let marketOpenTimer;
    let sessionTimer;
    let panelTimer;
    let failure = null;
    let settled = false;
    let localCloseRequested = false;
    let sessionCompleted = false;
    let sessionStartedAt = null;
    let sessionEndedAt = null;
    let operationalSessionEndsAt = null;
    let sessionEndIsAnchored = false;
    let operationalSessionDurationMs =
      openingMode === "TEST"
        ? testSessionDurationMs
        : openingSessionEndTimestamp(processStartedAt) -
          regularOpenTimestamp(processStartedAt);
    let totalTrades = 0;
    let openingCanBeDetermined = openingMode === "TEST";
    let operationalSessionStarted = false;
    const postOpening = openingMode === "POST-OPENING";
    let interruptRequested = false;

    function elapsedSeconds() {
      if (sessionStartedAt === null) {
        return 0;
      }
      const end = sessionEndedAt ?? Date.now();
      return (end - sessionStartedAt) / 1000;
    }

    function showEvent(message) {
      const timestamp = new Date().toISOString();
      const event = `[${timestamp}] ${message}`;
      recentEvents.push(event);
      if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
      }
      renderPanel();
    }

    function recordMarketEvent(message) {
      const timestamp = new Date().toISOString();
      const event = `[${timestamp}] ${message}`;
      recentEvents.push(event);
      if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
      }
      logs.eventsStream.write(`${event}\n`);
      renderPanel();
    }

    function recordOperationalEvent(message) {
      recordMarketEvent(message);
    }

    function renderPanel(force = false) {
      if (!renderOutput) {
        return;
      }
      if (!process.stdout.isTTY && !force) {
        return;
      }

      const elapsed = elapsedSeconds();
      const duration = postOpening
        ? "UNTIL CTRL+C"
        : formatDuration(operationalSessionDurationMs);
      const lines = [
        "ALOP MULTI — ALPACA IEX",
        `OPERATING MODE | ${openingMode}`,
        ...(postOpening ? ["POST-OPENING — ANALYTICAL ONLY"] : []),
        `STATUS | ${stage} | ${elapsed.toFixed(1)}/${duration} | ` +
          `Symbols ${symbols.length} | Trades ${totalTrades}`,
        "",
        [
          "SYMBOL".padEnd(6),
          "QTY".padStart(3),
          "LAST".padStart(10),
          "OPEN".padStart(10),
          "LOW".padStart(10),
          "DD%".padStart(7),
          "STATE".padEnd(12),
          "TRADES".padStart(8),
          "OPENING".padStart(10),
          "LAST".padStart(10),
        ].join(" "),
      ];

      for (const state of states.values()) {
        const price =
          state.lastPrice === null ? "-" : state.lastPrice.toFixed(4);
        const opening =
          state.openingPrice === null ? "-" : state.openingPrice.toFixed(4);
        const low =
          state.lowestPrice === null ? "-" : state.lowestPrice.toFixed(4);
        const drawdown =
          state.drawdownPercent === null
            ? "-"
            : state.drawdownPercent.toFixed(2);
        const openingTrade = compactMarketTimestamp(state.openingTimestamp);
        const lastTrade = compactMarketTimestamp(state.lastTimestamp);
        lines.push(
          [
            state.symbol.padEnd(6),
            String(state.quantity).padStart(3),
            price.padStart(10),
            opening.padStart(10),
            low.padStart(10),
            drawdown.padStart(7),
            state.state.padEnd(12),
            String(state.tradeCount).padStart(8),
            openingTrade.padStart(10),
            lastTrade.padStart(10),
          ].join(" "),
        );
      }

      lines.push("", "RECENT EVENTS");
      lines.push(...(recentEvents.length ? recentEvents : ["-"]));
      const output = `${lines.join("\n")}\n`;

      if (process.stdout.isTTY) {
        process.stdout.write(`\x1b[2J\x1b[H${output}`);
      } else {
        process.stdout.write(output);
      }
    }

    function stopPanel() {
      clearInterval(panelTimer);
      panelTimer = undefined;
    }

    function clearTimers() {
      clearTimeout(phaseTimer);
      clearTimeout(marketOpenTimer);
      clearTimeout(sessionTimer);
    }

    function handleInterrupt() {
      if (interruptRequested || settled) {
        return;
      }
      interruptRequested = true;
      sessionEndedAt = Date.now();
      sessionCompleted = true;
      localCloseRequested = true;
      stage = "CLOSING";
      clearTimers();
      stopPanel();
      recordOperationalEvent("SIGINT | Closing session cleanly");
      renderPanel(true);

      if (socket && socket.readyState !== WebSocketImpl.CLOSED) {
        try {
          socket.close(1000, "local SIGINT");
          phaseTimer = setTimeout(settle, CLOSE_TIMEOUT_MS);
          return;
        } catch (error) {
          recordOperationalEvent(
            `SIGINT | WebSocket close request failed: ${error.message}`,
          );
        }
      }
      settle();
    }

    process.on("SIGINT", handleInterrupt);

    function completeOperationalSession() {
      sessionEndedAt = sessionEndIsAnchored
        ? operationalSessionEndsAt
        : Date.now();
      sessionCompleted = true;
      stage = "CLOSING";
      stopPanel();
      showEvent(
        openingMode === "TEST"
          ? `${formatDuration(testSessionDurationMs)} session completed`
          : "Operational session completed",
      );
      localCloseRequested = true;
      socket.close(1000, "trade session complete");
      phaseTimer = setTimeout(
        () =>
          fail(
            createFailure(
              "CLOSING",
              `Close timed out after ${CLOSE_TIMEOUT_MS} ms.`,
            ),
          ),
        CLOSE_TIMEOUT_MS,
      );
    }

    function startOperationalSession(
      startedAt,
      sessionEndsAt,
      marketOpen = false,
    ) {
      sessionStartedAt = startedAt;
      operationalSessionStarted = true;
      operationalSessionEndsAt = sessionEndsAt;
      operationalSessionDurationMs = sessionEndsAt - startedAt;
      sessionEndIsAnchored = marketOpen;
      stage = "RECEIVING TRADES";
      if (marketOpen) {
        recordOperationalEvent("MARKET OPEN");
        recordOperationalEvent("Operational session started");
      } else {
        showEvent(`${formatDuration(testSessionDurationMs)} session started`);
      }

      sessionTimer = setTimeout(
        completeOperationalSession,
        Math.max(0, operationalSessionEndsAt - Date.now()),
      );
    }

    function waitForMarketOpen(marketOpensAt, sessionEndsAt) {
      const remainingMs = marketOpensAt - Date.now();
      if (remainingMs > 0) {
        marketOpenTimer = setTimeout(
          () => waitForMarketOpen(marketOpensAt, sessionEndsAt),
          remainingMs,
        );
        return;
      }

      marketOpenTimer = undefined;
      startOperationalSession(marketOpensAt, sessionEndsAt, true);
    }

    function settle(error = null) {
      if (settled) {
        return;
      }
      settled = true;
      process.removeListener("SIGINT", handleInterrupt);
      clearTimers();
      stopPanel();
      if (error) {
        error.partialResult = {
          states,
          totalTrades,
          durationSeconds: elapsedSeconds(),
          operationalSessionDurationMs,
          postOpening,
        };
        reject(error);
      } else {
        resolve({
          states,
          totalTrades,
          durationSeconds: elapsedSeconds(),
          operationalSessionDurationMs,
          closeCode: null,
          closeReason: "",
          postOpening,
        });
      }
    }

    function waitForStep(step) {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => {
        fail(
          createFailure(step, `Timed out after ${STEP_TIMEOUT_MS} ms.`),
        );
      }, STEP_TIMEOUT_MS);
    }

    function fail(error) {
      if (failure || settled) {
        return;
      }
      failure = error;
      stage = error.stage;
      showEvent(`FAILURE | ${error.stage} | ${error.message}`);
      clearTimers();
      stopPanel();

      if (socket?.readyState === WebSocketImpl.OPEN) {
        localCloseRequested = true;
        socket.close(1000, "local failure");
        phaseTimer = setTimeout(
          () => settle(failure),
          CLOSE_TIMEOUT_MS,
        );
        return;
      }
      settle(failure);
    }

    function writeTrade(message) {
      const receivedAt = new Date().toISOString();
      const row = [
        receivedAt,
        message.t,
        message.S,
        message.p,
        message.s,
        message.i ?? "",
        message.x ?? "",
        JSON.stringify(message.c ?? []),
      ]
        .map(csvCell)
        .join(",");
      logs.pricesStream.write(`${row}\n`);
    }

    function processMessage(message, rawContent) {
      if (!message || typeof message !== "object") {
        throw createFailure(stage, "Alpaca returned an invalid message.", {
          unexpectedContent: rawContent,
        });
      }

      if (message.T === "error") {
        throw createFailure(
          stage,
          `Alpaca WebSocket error ${message.code ?? "unknown"}.`,
          {
            alpacaMessage: message.msg ?? "No message returned.",
            unexpectedContent: rawContent,
          },
        );
      }

      if (
        stage === "WAITING FOR CONNECTED" &&
        message.T === "success" &&
        message.msg === "connected"
      ) {
        showEvent('Alpaca connection confirmed: "connected"');
        stage = "WAITING FOR AUTHENTICATED";
        socket.send(
          JSON.stringify({
            action: "auth",
            key: process.env.ALPACA_API_KEY_ID,
            secret: process.env.ALPACA_API_SECRET_KEY,
          }),
        );
        showEvent("Authentication requested");
        waitForStep(stage);
        return;
      }

      if (
        stage === "WAITING FOR AUTHENTICATED" &&
        message.T === "success" &&
        message.msg === "authenticated"
      ) {
        showEvent('Authentication confirmed: "authenticated"');
        stage = "WAITING FOR SUBSCRIPTION";
        socket.send(
          JSON.stringify({
            action: "subscribe",
            trades: symbols,
          }),
        );
        showEvent(`Trades subscription requested: ${symbols.join(", ")}`);
        waitForStep(stage);
        return;
      }

      if (
        stage === "WAITING FOR SUBSCRIPTION" &&
        message.T === "subscription"
      ) {
        const confirmedTrades = Array.isArray(message.trades)
          ? message.trades
          : [];
        const missingSymbols = symbols.filter(
          (symbol) => !confirmedTrades.includes(symbol),
        );
        if (missingSymbols.length > 0) {
          throw createFailure(
            stage,
            `Unconfirmed symbols: ${missingSymbols.join(", ")}.`,
            {
              missingSymbols,
              unexpectedContent: rawContent,
            },
          );
        }

        clearTimeout(phaseTimer);
        showEvent(`Trades subscription confirmed: ${symbols.join(", ")}`);
        openingCanBeDetermined =
          openingMode === "TEST" ||
          (openingMode === "OPENING" &&
            isBeforeRegularOpen(processStartedAt));
        panelTimer = setInterval(renderPanel, PANEL_INTERVAL_MS);

        if (openingMode === "TEST") {
          const startedAt = Date.now();
          startOperationalSession(
            startedAt,
            startedAt + testSessionDurationMs,
          );
          return;
        }

        if (postOpening) {
          sessionStartedAt = Date.now();
          operationalSessionStarted = true;
          operationalSessionDurationMs = Infinity;
          stage = "RECEIVING TRADES";
          recordOperationalEvent(
            "POST-OPENING — ANALYTICAL ONLY | First valid trade per symbol " +
              "will be used as a provisional opening reference",
          );
          return;
        }

        if (!openingCanBeDetermined) {
          stage = "WAITING FOR MARKET OPEN";
          recordOperationalEvent(
            "OPENING unavailable: process started at or after 09:30 ET; " +
              "restart and select POST-OPENING",
          );
          return;
        }

        stage = "WAITING FOR MARKET OPEN";
        recordOperationalEvent("WAITING FOR MARKET OPEN");
        waitForMarketOpen(
          regularOpenTimestamp(processStartedAt),
          openingSessionEndTimestamp(processStartedAt),
        );
        return;
      }

      if (
        ["WAITING FOR MARKET OPEN", "RECEIVING TRADES"].includes(stage) &&
        message.T === "t"
      ) {
        const state = states.get(message.S);
        const timestampMs =
          typeof message.t === "string" ? Date.parse(message.t) : NaN;
        if (
          !state ||
          typeof message.p !== "number" ||
          !Number.isFinite(message.p) ||
          message.p <= 0 ||
          !Number.isInteger(message.s) ||
          message.s <= 0 ||
          !Number.isFinite(timestampMs)
        ) {
          throw createFailure(
            stage,
            "Alpaca returned an invalid trade.",
            { unexpectedContent: rawContent },
          );
        }

        state.lastPrice = message.p;
        state.tradeCount += 1;
        state.firstTimestamp ??= message.t;
        state.lastTimestamp = message.t;
        totalTrades += 1;
        writeTrade(message);

        if (state.state === "WAITING_OPEN") {
          if (
            !postOpening &&
            !acceptsOpeningTrade(
              openingCanBeDetermined,
              operationalSessionStarted,
              timestampMs,
              openingMode,
            )
          ) {
            return;
          }

          state.openingPrice = message.p;
          state.openingTimestamp = message.t;
          state.lowestPrice = message.p;
          state.lowestTimestamp = message.t;
          state.drawdownPercent = 0;
          state.state = "TRACKING";
          recordMarketEvent(
            postOpening
              ? `${state.symbol} | POST-OPENING REFERENCE | ${message.p} | ${message.t}`
              : `${state.symbol} | OPENING PRICE | MODE ${openingMode} | ` +
                  `${message.p} | ${message.t}`,
          );
          return;
        }

        if (message.p < state.lowestPrice) {
          state.lowestPrice = message.p;
          state.lowestTimestamp = message.t;
          state.drawdownPercent =
            ((state.lowestPrice - state.openingPrice) / state.openingPrice) *
            100;
          recordMarketEvent(
            `${state.symbol} | NEW LOW | ${message.p} | ${message.t} | ` +
              `DD ${state.drawdownPercent.toFixed(2)}%`,
          );
        }

        if (
          state.state === "TRACKING" &&
          state.lowestPrice <=
            state.openingPrice * (1 - ENTRY_DRAWDOWN_PCT / 100)
        ) {
          state.state = "ARMED";
          state.armedTimestamp = message.t;
          recordMarketEvent(
            `${state.symbol} ARMED | opening ${state.openingPrice.toFixed(4)} | ` +
              `low ${state.lowestPrice.toFixed(4)} | ` +
              `DD ${state.drawdownPercent.toFixed(2)}%`,
          );
          return;
        }

        if (state.state === "ARMED" && message.p >= state.openingPrice) {
          state.state = "TRIGGERED";
          state.triggerTimestamp = message.t;
          recordMarketEvent(
            `${state.symbol} ENTRY TRIGGER | price ${message.p.toFixed(4)} | ` +
              `opening ${state.openingPrice.toFixed(4)}`,
          );
        }
        return;
      }

      if (stage === "CLOSING") {
        return;
      }

      if (["c", "x"].includes(message.T)) {
        return;
      }

      throw createFailure(
        stage,
        `Unexpected Alpaca message: ${JSON.stringify(message)}`,
        { unexpectedContent: rawContent },
      );
    }

    logs.eventsStream.on("error", (error) => {
      fail(createFailure("LOGGING", `events.log error: ${error.message}`));
    });
    logs.pricesStream.on("error", (error) => {
      fail(createFailure("LOGGING", `prices.csv error: ${error.message}`));
    });

    if (typeof WebSocketImpl !== "function") {
      settle(
        createFailure("CONFIGURATION", "Native WebSocket is unavailable."),
      );
      return;
    }

    showEvent(`Symbols validated: ${symbols.join(", ")}`);
    showEvent(`Run directory created: ${logs.runDirectory}`);
    renderPanel(true);

    try {
      socket = new WebSocketImpl(STREAM_URL);
    } catch (error) {
      settle(
        createFailure(
          "CONNECTING",
          `Could not create the WebSocket connection: ${error.message}`,
        ),
      );
      return;
    }
    waitForStep("WAITING FOR CONNECTED");

    socket.addEventListener("open", () => {
      stage = "WAITING FOR CONNECTED";
      showEvent("WebSocket transport opened");
    });

    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") {
          throw createFailure(
            stage,
            "Received a non-text WebSocket message.",
          );
        }
        const messages = JSON.parse(event.data);
        if (!Array.isArray(messages)) {
          throw createFailure(stage, "Alpaca message is not an array.", {
            unexpectedContent: event.data,
          });
        }
        for (const message of messages) {
          processMessage(message, event.data);
        }
      } catch (error) {
        fail(
          error?.stage
            ? error
            : createFailure(
                stage,
                `Invalid WebSocket message: ${error.message}`,
                { unexpectedContent: event.data },
              ),
        );
      }
    });

    socket.addEventListener("error", () => {
      fail(
        createFailure(
          stage,
          "Native WebSocket emitted a connection error.",
        ),
      );
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(phaseTimer);
      showEvent(
        `WebSocket closed: ${event.code} / ${event.reason || "no reason"}`,
      );
      stopPanel();
      renderPanel(true);

      if (failure) {
        failure.closeCode = event.code;
        failure.closeReason = event.reason;
        settle(failure);
        return;
      }

      if (
        stage === "CLOSING" &&
        localCloseRequested &&
        sessionCompleted &&
        (event.code === 1000 || event.code === 1006)
      ) {
        settle();
        return;
      }

      settle(
        createFailure(stage, "WebSocket closed before session completion.", {
          closeCode: event.code,
          closeReason: event.reason,
        }),
      );
    });
  });
}

function printSummary(result, logs, openingMode) {
  console.log();
  console.log("SESSION SUMMARY");
  console.log(`Operating mode: ${openingMode}`);
  if (result.postOpening) {
    console.log("Status: POST-OPENING — ANALYTICAL ONLY");
  }
  console.log(
    `Configured operational duration: ${
      result.postOpening
        ? "until Ctrl+C"
        : formatDuration(result.operationalSessionDurationMs)
    }`,
  );
  for (const state of result.states.values()) {
    const opening =
      state.openingPrice === null ? "-" : state.openingPrice.toFixed(4);
    const low =
      state.lowestPrice === null ? "-" : state.lowestPrice.toFixed(4);
    const drawdown =
      state.drawdownPercent === null
        ? "-"
        : `${state.drawdownPercent.toFixed(2)}%`;
    const armed =
      state.armedTimestamp === null
        ? "NO"
        : `YES @ ${compactMarketTimestamp(state.armedTimestamp)}`;
    const triggered =
      state.triggerTimestamp === null
        ? "NO"
        : `YES @ ${compactMarketTimestamp(state.triggerTimestamp)}`;
    console.log(
      `${state.symbol}: ${state.tradeCount} trades | ${
        result.postOpening ? "Post-opening reference" : "Opening"
      } ${opening} | ` +
        `Low ${low} | DD ${drawdown} | State ${state.state} | ` +
        `Armed ${armed} | Trigger ${triggered}`,
    );
  }
  console.log(`Total trades: ${result.totalTrades}`);
  console.log(
    `Actual operational duration: ${result.durationSeconds.toFixed(3)} seconds`,
  );
  console.log(`events.log: ${logs.eventsPath}`);
  console.log(`prices.csv: ${logs.pricesPath}`);
  console.log("Result: SUCCESS");
}

async function main() {
  const symbols = readSymbols();
  const { openingMode, processStartedAt } = await selectOperatingMode();
  validateOpeningMode(openingMode);
  loadCredentials();
  const logs = await createRunLogs();

  let result;
  try {
    result = await runMarketDataSession(
      symbols,
      logs,
      processStartedAt,
      { openingMode },
    );
  } catch (error) {
    console.error("Result: FAILURE");
    console.error(`Stage: ${error.stage ?? "UNKNOWN"}`);
    console.error(`Error: ${error.message}`);
    if (error.alpacaMessage) {
      console.error(`Alpaca message: ${error.alpacaMessage}`);
    }
    if (error.unexpectedContent) {
      console.error(`Unexpected content: ${error.unexpectedContent}`);
    }
    if (error.closeCode !== undefined) {
      console.error(`WebSocket close code: ${error.closeCode}`);
      console.error(
        `WebSocket close reason: ${error.closeReason || "no reason"}`,
      );
    }
    console.error(`events.log: ${logs.eventsPath}`);
    console.error(`prices.csv: ${logs.pricesPath}`);
    process.exitCode = 1;
  } finally {
    await closeRunLogs(logs);
  }

  if (result) {
    printSummary(result, logs, openingMode);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Result: FAILURE");
    console.error(`Stage: ${error.stage ?? "STARTUP"}`);
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runMarketDataSession,
};
