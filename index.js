const fs = require("node:fs");
const path = require("node:path");

const SYMBOL = "NVDA";
const DATA_FEED = "iex";
const REQUEST_TIMEOUT_MS = 10_000;
const STREAM_DURATION_MS = 30_000;
const STREAM_CONNECT_TIMEOUT_MS = 10_000;

const TRADING_API_BASE = "https://paper-api.alpaca.markets";
const MARKET_DATA_API_BASE = "https://data.alpaca.markets";
const MARKET_DATA_STREAM_URL = `wss://stream.data.alpaca.markets/v2/${DATA_FEED}`;

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");

  if (!fs.existsSync(envPath)) {
    throw new Error("Credentials: .env.local was not found.");
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) {
    throw new Error(
      "Credentials: ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required.",
    );
  }
}

async function getJson(url, step) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = (await response.text()).trim();
      const details = responseText ? ` - ${responseText}` : "";
      throw new Error(`${step}: HTTP ${response.status}${details}`);
    }

    return response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${step}: request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runRestPreflight() {
  console.log("JSB — Alpaca Stage 01 Preflight\n");
  console.log("Environment: PAPER");
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Market data feed: ${DATA_FEED.toUpperCase()}\n`);
  console.log("Credentials: loaded");

  const account = await getJson(`${TRADING_API_BASE}/v2/account`, "Paper account");
  console.log("Paper account: authenticated");
  console.log(`Account status: ${account.status}`);
  console.log(`Buying power: ${account.buying_power}`);
  console.log(`Trading blocked: ${account.trading_blocked}\n`);

  const clock = await getJson(`${TRADING_API_BASE}/v2/clock`, "Market clock");
  console.log("Market clock:");
  console.log(`Timestamp: ${clock.timestamp}`);
  console.log(`Market open: ${clock.is_open}`);
  console.log(`Next open: ${clock.next_open}`);
  console.log(`Next close: ${clock.next_close}\n`);

  const asset = await getJson(
    `${TRADING_API_BASE}/v2/assets/${encodeURIComponent(SYMBOL)}`,
    "Asset",
  );
  console.log("Asset:");
  console.log(`Symbol: ${asset.symbol}`);
  console.log(`Name: ${asset.name}`);
  console.log(`Exchange: ${asset.exchange}`);
  console.log(`Tradable: ${asset.tradable}`);
  console.log(`Marginable: ${asset.marginable}`);
  console.log(`Fractionable: ${asset.fractionable}\n`);

  const latestTrade = await getJson(
    `${MARKET_DATA_API_BASE}/v2/stocks/${encodeURIComponent(SYMBOL)}/trades/latest?feed=${encodeURIComponent(DATA_FEED)}`,
    "Latest trade",
  );
  console.log("Latest trade:");
  console.log(`Price: ${latestTrade.trade.p}`);
  console.log(`Size: ${latestTrade.trade.s}`);
  console.log(`Timestamp: ${latestTrade.trade.t}\n`);

  const latestQuote = await getJson(
    `${MARKET_DATA_API_BASE}/v2/stocks/${encodeURIComponent(SYMBOL)}/quotes/latest?feed=${encodeURIComponent(DATA_FEED)}`,
    "Latest quote",
  );
  console.log("Latest quote:");
  console.log(`Bid: ${latestQuote.quote.bp}`);
  console.log(`Bid size: ${latestQuote.quote.bs}`);
  console.log(`Ask: ${latestQuote.quote.ap}`);
  console.log(`Ask size: ${latestQuote.quote.as}`);
  console.log(`Timestamp: ${latestQuote.quote.t}\n`);

  console.log("No orders sent.");
  console.log("Preflight completed successfully.\n");
}

async function messageDataToText(data) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Blob) {
    return data.text();
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  throw new Error("unsupported WebSocket message format");
}

function printStreamSummary(state) {
  const observationEnd = state.observationEndedAt ?? Date.now();
  const observationDuration = state.observationStartedAt
    ? (observationEnd - state.observationStartedAt) / 1000
    : 0;
  const infrastructureApproved = isStreamApproved(state);
  const closeClassification = classifyClose(state);

  console.log("\nJSB — Alpaca IEX Stream Summary\n");
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Feed: ${DATA_FEED.toUpperCase()}`);
  console.log(`Connected: ${state.connected ? "yes" : "no"}`);
  console.log(`Authenticated: ${state.authenticated ? "yes" : "no"}`);
  console.log(`Subscribed to trades: ${state.subscribedTrades ? "yes" : "no"}`);
  console.log(`Subscribed to quotes: ${state.subscribedQuotes ? "yes" : "no"}`);
  console.log(`Observation duration: ${observationDuration.toFixed(1)} seconds`);
  console.log(`Trades received: ${state.trades}`);
  console.log(`Quotes received: ${state.quotes}`);
  console.log(`Control messages: ${state.controlMessages}`);
  console.log(`Errors: ${state.errors}`);
  console.log(`Unknown messages: ${state.unknownMessages}`);
  console.log(`Close code: ${state.closeCode ?? "not available"}`);
  console.log(`Close reason: ${state.closeReason || "none"}`);
  console.log(`Close classification: ${closeClassification}`);

  if (isAcceptedLocal1006(state)) {
    console.log("Close initiated locally after completed observation: yes");
    console.log("Peer Close frame observed: no");
    console.log("Restricted local 1006 acceptance applied: yes");
  }

  console.log(`Trade data received: ${state.trades > 0 ? "yes" : "no"}`);
  console.log(`Quote data received: ${state.quotes > 0 ? "yes" : "no"}`);
  console.log(`Infrastructure validated: ${infrastructureApproved ? "yes" : "no"}\n`);
  console.log("No orders sent.");

  if (infrastructureApproved) {
    console.log("Stream completed successfully.");
  } else {
    console.log("Stream did not complete successfully.");
  }
}

function hasCompletedLocalShutdown(state) {
  return (
    state.connected &&
    state.authenticated &&
    state.subscribedTrades &&
    state.subscribedQuotes &&
    state.observationCompleted &&
    state.shutdownInitiatedLocally &&
    state.shutdownReason === "observation complete" &&
    state.closeRequestedAt !== null &&
    state.closeEventReceived &&
    state.closeEventAt > state.closeRequestedAt &&
    !state.webSocketErrorOccurred &&
    !state.failure
  );
}

function isAcceptedLocal1006(state) {
  return state.closeCode === 1006 && hasCompletedLocalShutdown(state);
}

function isStreamApproved(state) {
  return (
    hasCompletedLocalShutdown(state) &&
    (state.closeCode === 1000 || isAcceptedLocal1006(state))
  );
}

function classifyClose(state) {
  if (isAcceptedLocal1006(state)) {
    return "locally initiated close with missing peer Close frame";
  }

  if (state.closeCode === 1000 && hasCompletedLocalShutdown(state)) {
    return "normal close handshake";
  }

  if (!state.shutdownInitiatedLocally || state.closeRequestedAt === null) {
    return "unexpected remote close";
  }

  return "local close after an incomplete or failed stream";
}

function runMarketDataStream() {
  return new Promise((resolve, reject) => {
    const state = {
      connected: false,
      authenticated: false,
      subscribedTrades: false,
      subscribedQuotes: false,
      observationStartedAt: null,
      observationEndedAt: null,
      observationCompleted: false,
      trades: 0,
      quotes: 0,
      controlMessages: 0,
      errors: 0,
      unknownMessages: 0,
      closeCode: null,
      closeReason: "",
      shutdownInitiatedLocally: false,
      shutdownReason: "",
      closeRequestedAt: null,
      closeEventReceived: false,
      closeEventAt: null,
      webSocketErrorOccurred: false,
      failure: null,
    };

    let socket;
    let phaseTimer;
    let observationTimer;
    let authSent = false;
    let subscriptionSent = false;
    let shutdownStarted = false;
    let settled = false;

    function clearTimers() {
      clearTimeout(phaseTimer);
      clearTimeout(observationTimer);
    }

    function finish() {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      process.removeListener("SIGINT", handleSigint);
      printStreamSummary(state);

      if (isStreamApproved(state)) {
        resolve(state);
      } else {
        reject(state.failure ?? new Error("WebSocket stream validation failed."));
      }
    }

    function closeStream(reason) {
      if (shutdownStarted) {
        return;
      }

      shutdownStarted = true;
      state.shutdownInitiatedLocally = true;
      state.shutdownReason = reason;
      clearTimers();

      if (state.observationStartedAt && !state.observationEndedAt) {
        state.observationEndedAt = Date.now();
      }

      if (
        socket.readyState === globalThis.WebSocket.OPEN ||
        socket.readyState === globalThis.WebSocket.CONNECTING
      ) {
        try {
          state.closeRequestedAt = Date.now();
          socket.close(1000, reason);
        } catch (error) {
          state.failure ??= new Error(`WebSocket close failed: ${error.message}`);
          state.errors += 1;
          finish();
        }
      } else if (socket.readyState === globalThis.WebSocket.CLOSED) {
        finish();
      }
    }

    function failStream(message, errorAlreadyCounted = false) {
      if (!state.failure) {
        state.failure = new Error(message);
        if (!errorAlreadyCounted) {
          state.errors += 1;
        }
        console.error(`WebSocket failure: ${message}`);
      }

      closeStream("stream failure");
    }

    function handleSigint() {
      if (shutdownStarted) {
        return;
      }

      console.log("\nSIGINT received. Closing the WebSocket stream.");
      failStream("Stream interrupted by SIGINT.");
    }

    function processMessage(message) {
      if (!message || typeof message !== "object") {
        state.unknownMessages += 1;
        console.log("Unknown WebSocket message: non-object payload.");
        return;
      }

      if (message.T === "success") {
        state.controlMessages += 1;

        if (message.msg === "connected") {
          console.log("WebSocket connection: confirmed");

          if (!authSent) {
            authSent = true;
            socket.send(
              JSON.stringify({
                action: "auth",
                key: process.env.ALPACA_API_KEY_ID,
                secret: process.env.ALPACA_API_SECRET_KEY,
              }),
            );
            console.log("WebSocket authentication: requested");
          }
          return;
        }

        if (message.msg === "authenticated") {
          if (!authSent) {
            failStream("Authentication was confirmed before it was requested.");
            return;
          }

          state.authenticated = true;
          clearTimeout(phaseTimer);
          console.log("WebSocket authentication: confirmed");

          if (!subscriptionSent) {
            subscriptionSent = true;
            socket.send(
              JSON.stringify({
                action: "subscribe",
                trades: [SYMBOL],
                quotes: [SYMBOL],
              }),
            );
            console.log("WebSocket subscription: requested");
            phaseTimer = setTimeout(
              () => failStream("WebSocket subscription confirmation timed out."),
              STREAM_CONNECT_TIMEOUT_MS,
            );
          }
          return;
        }

        state.unknownMessages += 1;
        console.log(`Unknown WebSocket success message: ${message.msg ?? "missing"}`);
        return;
      }

      if (message.T === "subscription") {
        state.controlMessages += 1;

        if (!state.authenticated || !subscriptionSent) {
          failStream("Subscription was confirmed before authentication.");
          return;
        }

        state.subscribedTrades =
          Array.isArray(message.trades) && message.trades.includes(SYMBOL);
        state.subscribedQuotes =
          Array.isArray(message.quotes) && message.quotes.includes(SYMBOL);

        if (!state.subscribedTrades || !state.subscribedQuotes) {
          failStream("Alpaca did not confirm both trades and quotes subscriptions.");
          return;
        }

        clearTimeout(phaseTimer);
        console.log("WebSocket trades subscription: confirmed");
        console.log("WebSocket quotes subscription: confirmed");
        console.log(`Observing the stream for ${STREAM_DURATION_MS / 1000} seconds...\n`);
        state.observationStartedAt = Date.now();
        observationTimer = setTimeout(() => {
          state.observationCompleted = true;
          closeStream("observation complete");
        }, STREAM_DURATION_MS);
        return;
      }

      if (message.T === "t") {
        state.trades += 1;
        console.log(
          `Trade #${state.trades} | ${message.S} | Price: ${message.p} | Size: ${message.s} | Time: ${message.t}`,
        );
        return;
      }

      if (message.T === "q") {
        state.quotes += 1;
        console.log(
          `Quote #${state.quotes} | ${message.S} | Bid: ${message.bp} x ${message.bs} | Ask: ${message.ap} x ${message.as} | Time: ${message.t}`,
        );
        return;
      }

      if (message.T === "error") {
        state.errors += 1;
        const code = message.code ?? "unknown";
        const details = message.msg ?? "no details";
        failStream(`Alpaca error ${code}: ${details}`, true);
        return;
      }

      state.unknownMessages += 1;
      console.log(`Unknown WebSocket message type: ${message.T ?? "missing"}`);
    }

    console.log("JSB — Alpaca IEX Market Data Stream\n");
    console.log(`Endpoint: ${MARKET_DATA_STREAM_URL}`);
    console.log(`Symbol: ${SYMBOL}`);
    console.log(`Feed: ${DATA_FEED.toUpperCase()}`);
    console.log("WebSocket connection: opening");

    process.once("SIGINT", handleSigint);
    socket = new globalThis.WebSocket(MARKET_DATA_STREAM_URL);

    phaseTimer = setTimeout(
      () => failStream("WebSocket connection timed out."),
      STREAM_CONNECT_TIMEOUT_MS,
    );

    socket.addEventListener("open", () => {
      state.connected = true;
      clearTimeout(phaseTimer);
      console.log("WebSocket connection: open");
      phaseTimer = setTimeout(
        () => failStream("WebSocket authentication confirmation timed out."),
        STREAM_CONNECT_TIMEOUT_MS,
      );
    });

    socket.addEventListener("message", async (event) => {
      if (settled) {
        return;
      }

      try {
        const text = await messageDataToText(event.data);
        const payload = JSON.parse(text);
        const messages = Array.isArray(payload) ? payload : [payload];

        for (const message of messages) {
          processMessage(message);
          if (state.failure) {
            break;
          }
        }
      } catch (error) {
        failStream(`Invalid WebSocket message: ${error.message}`);
      }
    });

    socket.addEventListener("error", () => {
      state.webSocketErrorOccurred = true;
      failStream("WebSocket connection error.");
    });

    socket.addEventListener("close", (event) => {
      clearTimers();
      state.closeEventReceived = true;
      state.closeEventAt = Date.now();
      state.closeCode = event.code;
      state.closeReason = event.reason;

      if (!state.observationEndedAt && state.observationStartedAt) {
        state.observationEndedAt = Date.now();
      }

      console.log(
        `WebSocket connection: closed (code ${event.code}, reason: ${event.reason || "none"})`,
      );

      if (!shutdownStarted && !state.failure) {
        state.failure = new Error("WebSocket closed remotely before completion.");
        state.errors += 1;
      } else if (
        !state.failure &&
        event.code !== 1000 &&
        !isAcceptedLocal1006(state)
      ) {
        state.failure = new Error(`WebSocket closed with unexpected code ${event.code}.`);
        state.errors += 1;
      }

      finish();
    });
  });
}

async function main() {
  loadLocalEnv();
  await runRestPreflight();
  await runMarketDataStream();
}

main().catch((error) => {
  console.error(`JSB failed: ${error.message}`);
  process.exitCode = 1;
});
