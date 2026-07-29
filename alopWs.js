const ENV_FILE = ".env.local";
const STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";
const STEP_TIMEOUT_MS = 10 * 1000;
const SESSION_DURATION_MS = 60 * 1000;
const CLOSE_TIMEOUT_MS = 5 * 1000;
const LOG_TRADES = true;

const SYMBOL_ARGUMENTS = process.argv.slice(2);
let SYMBOLS = [];

function validateSymbols() {
  if (SYMBOL_ARGUMENTS.length === 0) {
    throw createFailure(
      "COMMAND",
      "Usage: node alopWs.js NVDA [TSLA AMD ...]",
    );
  }

  const seen = new Set();
  SYMBOLS = [];

  for (const argument of SYMBOL_ARGUMENTS) {
    const symbol = argument.trim().toUpperCase();
    if (!symbol || !/^[A-Z][A-Z0-9.-]*$/.test(symbol)) {
      throw createFailure(
        "COMMAND",
        `Invalid symbol: ${argument || "(empty)"}.`,
      );
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      SYMBOLS.push(symbol);
    }
  }
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

function createFailure(stage, message, details = {}) {
  const error = new Error(message);
  error.stage = stage;
  Object.assign(error, details);
  return error;
}

function validateConnectionAndAuthentication() {
  return new Promise((resolve, reject) => {
    let stage = "CONNECTING";
    let socket;
    let timer;
    let failure = null;
    let localCloseRequested = false;
    let settled = false;
    let sessionCompleted = false;
    let sessionStartedAt = null;
    let sessionEndedAt = null;
    let totalTradeCount = 0;
    const symbolSet = new Set(SYMBOLS);
    const symbolStats = new Map(
      SYMBOLS.map((symbol) => [
        symbol,
        {
          count: 0,
          firstTradeTimestamp: null,
          lastTradeTimestamp: null,
        },
      ]),
    );

    function clearTimer() {
      clearTimeout(timer);
    }

    function settle(error = null) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function waitForStep(name, timeoutMs) {
      clearTimer();
      timer = setTimeout(() => {
        if (failure) {
          settle(failure);
          return;
        }
        fail(createFailure(name, `Timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
    }

    function printSessionSummary() {
      const durationSeconds =
        sessionStartedAt === null || sessionEndedAt === null
          ? 0
          : (sessionEndedAt - sessionStartedAt) / 1000;

      console.log("Session summary by symbol:");
      for (const symbol of SYMBOLS) {
        const stats = symbolStats.get(symbol);
        console.log(`Symbol: ${symbol}`);
        console.log(`Trades received: ${stats.count}`);
        console.log(
          `First trade timestamp: ${stats.firstTradeTimestamp ?? "none"}`,
        );
        console.log(
          `Last trade timestamp: ${stats.lastTradeTimestamp ?? "none"}`,
        );
      }

      console.log("Global session summary:");
      console.log(`Subscribed symbols: ${SYMBOLS.length}`);
      console.log(`Total trades: ${totalTradeCount}`);
      console.log(`Session duration: ${durationSeconds.toFixed(3)} seconds`);
    }

    function fail(error) {
      if (failure || settled) {
        return;
      }

      failure = error;
      stage = error.stage;
      clearTimer();

      if (socket?.readyState === globalThis.WebSocket.OPEN) {
        localCloseRequested = true;
        socket.close(1000, "local failure");
        waitForStep("CLOSING AFTER FAILURE", CLOSE_TIMEOUT_MS);
        return;
      }

      if (socket?.readyState === globalThis.WebSocket.CONNECTING) {
        waitForStep("CLOSING AFTER FAILURE", CLOSE_TIMEOUT_MS);
        return;
      }

      settle(failure);
    }

    if (typeof globalThis.WebSocket !== "function") {
      settle(
        createFailure("CONFIGURATION", "Native WebSocket is unavailable."),
      );
      return;
    }

    console.log(`Symbols validated: ${SYMBOLS.join(", ")}`);
    console.log(`Endpoint: ${STREAM_URL}`);
    console.log("WebSocket: connecting");

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
    waitForStep("WAITING FOR CONNECTED", STEP_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      stage = "WAITING FOR CONNECTED";
      console.log("WebSocket transport: open");
    });

    socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string") {
          throw createFailure(stage, "Received a non-text WebSocket message.");
        }

        const messages = JSON.parse(event.data);
        if (!Array.isArray(messages)) {
          throw createFailure(stage, "Alpaca message is not an array.");
        }

        for (const message of messages) {
          if (!message || typeof message !== "object") {
            throw createFailure(stage, "Alpaca returned an invalid message.");
          }

          if (message.T === "error") {
            throw createFailure(
              stage,
              `Alpaca WebSocket error ${message.code ?? "unknown"}.`,
              {
                alpacaMessage: message.msg ?? "No message returned.",
              },
            );
          }

          if (
            stage === "WAITING FOR CONNECTED" &&
            message.T === "success" &&
            message.msg === "connected"
          ) {
            console.log('Alpaca connection: "connected"');
            stage = "WAITING FOR AUTHENTICATED";
            socket.send(
              JSON.stringify({
                action: "auth",
                key: process.env.ALPACA_API_KEY_ID,
                secret: process.env.ALPACA_API_SECRET_KEY,
              }),
            );
            console.log("Authentication: requested");
            waitForStep(stage, STEP_TIMEOUT_MS);
            continue;
          }

          if (
            stage === "WAITING FOR AUTHENTICATED" &&
            message.T === "success" &&
            message.msg === "authenticated"
          ) {
            console.log('Authentication: "authenticated"');
            stage = "WAITING FOR SUBSCRIPTION";
            socket.send(
              JSON.stringify({
                action: "subscribe",
                trades: SYMBOLS,
              }),
            );
            console.log(
              `Trades subscription: requested for ${SYMBOLS.join(", ")}`,
            );
            waitForStep(stage, STEP_TIMEOUT_MS);
            continue;
          }

          if (
            stage === "WAITING FOR SUBSCRIPTION" &&
            message.T === "subscription"
          ) {
            const confirmedTrades = Array.isArray(message.trades)
              ? message.trades
              : [];
            const missingSymbols = SYMBOLS.filter(
              (symbol) => !confirmedTrades.includes(symbol),
            );
            if (messages.length !== 1 || missingSymbols.length > 0) {
              throw createFailure(
                stage,
                `Alpaca did not confirm these symbols: ${missingSymbols.join(", ") || "invalid subscription response"}.`,
                {
                  missingSymbols,
                  unexpectedContent: event.data,
                },
              );
            }

            console.log(
              `Trades subscription: confirmed for ${SYMBOLS.join(", ")}`,
            );
            stage = "RECEIVING TRADES";
            sessionStartedAt = Date.now();
            console.log(
              `Trade session: started for ${SESSION_DURATION_MS / 1000} seconds`,
            );
            clearTimer();
            timer = setTimeout(() => {
              sessionEndedAt = Date.now();
              sessionCompleted = true;
              stage = "CLOSING";
              localCloseRequested = true;
              printSessionSummary();
              socket.close(1000, "trade session complete");
              waitForStep(stage, CLOSE_TIMEOUT_MS);
            }, SESSION_DURATION_MS);
            continue;
          }

          if (stage === "RECEIVING TRADES" && message.T === "t") {
            const timestampMs =
              typeof message.t === "string" ? Date.parse(message.t) : NaN;
            const validTrade =
              symbolSet.has(message.S) &&
              typeof message.p === "number" &&
              Number.isFinite(message.p) &&
              message.p > 0 &&
              Number.isInteger(message.s) &&
              message.s > 0 &&
              Number.isFinite(timestampMs);
            const validTradeId =
              message.i === undefined ||
              (Number.isInteger(message.i) && message.i >= 0);
            const validExchange =
              message.x === undefined ||
              (typeof message.x === "string" && message.x.length > 0);
            const validConditions =
              message.c === undefined ||
              (Array.isArray(message.c) &&
                message.c.every((condition) => typeof condition === "string"));

            if (
              !validTrade ||
              !validTradeId ||
              !validExchange ||
              !validConditions
            ) {
              throw createFailure(
                stage,
                "Alpaca returned an invalid trade.",
                { unexpectedContent: event.data },
              );
            }

            totalTradeCount += 1;
            const stats = symbolStats.get(message.S);
            stats.count += 1;
            stats.firstTradeTimestamp ??= message.t;
            stats.lastTradeTimestamp = message.t;

            if (LOG_TRADES) {
              console.log(`Trade ${totalTradeCount}:`);
              console.log(`Symbol: ${message.S}`);
              console.log(`Price: ${message.p}`);
              console.log(`Size: ${message.s}`);
              console.log(`Timestamp: ${message.t}`);
              if (message.i !== undefined) {
                console.log(`Trade ID: ${message.i}`);
              }
              if (message.x !== undefined) {
                console.log(`Exchange: ${message.x}`);
              }
              if (message.c !== undefined) {
                console.log(`Conditions: ${JSON.stringify(message.c)}`);
              }
            }

            continue;
          }

          if (stage === "CLOSING") {
            return;
          }

          throw createFailure(
            stage,
            `Unexpected Alpaca message: ${JSON.stringify(message)}`,
            { unexpectedContent: event.data },
          );
        }
      } catch (error) {
        fail(
          error?.stage
            ? error
            : createFailure(stage, `Invalid WebSocket message: ${error.message}`),
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
      clearTimer();
      console.log(
        `WebSocket close: ${event.code} / ${event.reason || "no reason"}`,
      );

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
        createFailure(stage, "WebSocket closed before successful completion.", {
          closeCode: event.code,
          closeReason: event.reason,
        }),
      );
    });
  });
}

async function main() {
  validateSymbols();
  loadCredentials();
  await validateConnectionAndAuthentication();
  console.log("Result: SUCCESS");
}

main().catch((error) => {
  console.error("Result: FAILURE");
  console.error(`Stage: ${error.stage ?? "UNKNOWN"}`);
  console.error(`Error: ${error.message}`);
  if (error.alpacaMessage) {
    console.error(`Alpaca message: ${error.alpacaMessage}`);
  }
  if (error.unexpectedContent) {
    console.error(`Unexpected content: ${error.unexpectedContent}`);
  }
  if (error.missingSymbols?.length) {
    console.error(`Unconfirmed symbols: ${error.missingSymbols.join(", ")}`);
  }
  if (error.closeCode !== undefined) {
    console.error(`WebSocket close code: ${error.closeCode}`);
    console.error(`WebSocket close reason: ${error.closeReason || "no reason"}`);
  }
  process.exitCode = 1;
});
