const fs = require("node:fs");
const path = require("node:path");

const ENV_FILE = ".env.local";
const STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";
const QUANTITY = 10;
const SESSION_DURATION_MS = 60 * 1000;
const PANEL_INTERVAL_MS = 500;
const STEP_TIMEOUT_MS = 10 * 1000;
const CLOSE_TIMEOUT_MS = 5 * 1000;
const MAX_RECENT_EVENTS = 6;

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

function runMarketDataSession(symbols, logs) {
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
        },
      ]),
    );
    const recentEvents = [];

    let socket;
    let stage = "CONNECTING";
    let phaseTimer;
    let sessionTimer;
    let panelTimer;
    let failure = null;
    let settled = false;
    let localCloseRequested = false;
    let sessionCompleted = false;
    let sessionStartedAt = null;
    let sessionEndedAt = null;
    let totalTrades = 0;

    function elapsedSeconds() {
      if (sessionStartedAt === null) {
        return 0;
      }
      const end = sessionEndedAt ?? Date.now();
      return (end - sessionStartedAt) / 1000;
    }

    function recordEvent(message) {
      const timestamp = new Date().toISOString();
      const event = `[${timestamp}] ${message}`;
      recentEvents.push(event);
      if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
      }
      logs.eventsStream.write(`${event}\n`);
      renderPanel();
    }

    function renderPanel(force = false) {
      if (!process.stdout.isTTY && !force) {
        return;
      }

      const elapsed = elapsedSeconds();
      const lines = [
        "ALOP MULTI — ALPACA IEX",
        `STATUS | ${stage} | ${elapsed.toFixed(1)}/${SESSION_DURATION_MS / 1000}s | ` +
          `Symbols ${symbols.length} | Trades ${totalTrades}`,
        "",
        "SYMBOL   QTY   LAST PRICE     TRADES   LAST TRADE",
      ];

      for (const state of states.values()) {
        const price =
          state.lastPrice === null ? "-" : state.lastPrice.toFixed(4);
        const lastTrade =
          state.lastTimestamp === null ? "-" : state.lastTimestamp;
        lines.push(
          `${state.symbol.padEnd(8)} ${String(state.quantity).padEnd(5)} ` +
            `${price.padEnd(14)} ${String(state.tradeCount).padEnd(8)} ${lastTrade}`,
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
      clearTimeout(sessionTimer);
    }

    function settle(error = null) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      stopPanel();
      if (error) {
        reject(error);
      } else {
        resolve({
          states,
          totalTrades,
          durationSeconds: elapsedSeconds(),
          closeCode: null,
          closeReason: "",
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
      recordEvent(`FAILURE | ${error.stage} | ${error.message}`);
      clearTimers();
      stopPanel();

      if (socket?.readyState === globalThis.WebSocket.OPEN) {
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
        recordEvent('Alpaca connection confirmed: "connected"');
        stage = "WAITING FOR AUTHENTICATED";
        socket.send(
          JSON.stringify({
            action: "auth",
            key: process.env.ALPACA_API_KEY_ID,
            secret: process.env.ALPACA_API_SECRET_KEY,
          }),
        );
        recordEvent("Authentication requested");
        waitForStep(stage);
        return;
      }

      if (
        stage === "WAITING FOR AUTHENTICATED" &&
        message.T === "success" &&
        message.msg === "authenticated"
      ) {
        recordEvent('Authentication confirmed: "authenticated"');
        stage = "WAITING FOR SUBSCRIPTION";
        socket.send(
          JSON.stringify({
            action: "subscribe",
            trades: symbols,
          }),
        );
        recordEvent(`Trades subscription requested: ${symbols.join(", ")}`);
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
        recordEvent(`Trades subscription confirmed: ${symbols.join(", ")}`);
        stage = "RECEIVING TRADES";
        sessionStartedAt = Date.now();
        recordEvent("60-second session started");
        panelTimer = setInterval(renderPanel, PANEL_INTERVAL_MS);
        sessionTimer = setTimeout(() => {
          sessionEndedAt = Date.now();
          sessionCompleted = true;
          stage = "CLOSING";
          stopPanel();
          recordEvent("60-second session completed");
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
        }, SESSION_DURATION_MS);
        return;
      }

      if (stage === "RECEIVING TRADES" && message.T === "t") {
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

    if (typeof globalThis.WebSocket !== "function") {
      settle(
        createFailure("CONFIGURATION", "Native WebSocket is unavailable."),
      );
      return;
    }

    recordEvent(`Symbols validated: ${symbols.join(", ")}`);
    recordEvent(`Run directory created: ${logs.runDirectory}`);
    renderPanel(true);

    try {
      socket = new globalThis.WebSocket(STREAM_URL);
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
      recordEvent("WebSocket transport opened");
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
      recordEvent(
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

function printSummary(result, logs) {
  console.log();
  console.log("SESSION SUMMARY");
  for (const state of result.states.values()) {
    console.log(`${state.symbol}: ${state.tradeCount} trades`);
  }
  console.log(`Total trades: ${result.totalTrades}`);
  console.log(`Session duration: ${result.durationSeconds.toFixed(3)} seconds`);
  console.log(`events.log: ${logs.eventsPath}`);
  console.log(`prices.csv: ${logs.pricesPath}`);
  console.log("Result: SUCCESS");
}

async function main() {
  const symbols = readSymbols();
  loadCredentials();
  const logs = await createRunLogs();

  try {
    const result = await runMarketDataSession(symbols, logs);
    printSummary(result, logs);
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
}

main().catch((error) => {
  console.error("Result: FAILURE");
  console.error(`Stage: ${error.stage ?? "STARTUP"}`);
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
