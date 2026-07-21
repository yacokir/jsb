const fs = require("node:fs");
const path = require("node:path");

const SYMBOL = "NVDA";
const FEED = "iex";
const PAPER_API = "https://paper-api.alpaca.markets";
const STREAM_URL = `wss://stream.data.alpaca.markets/v2/${FEED}`;
const REQUEST_TIMEOUT_MS = 10_000;
const STREAM_TIMEOUT_MS = 60_000;
const SIMULATED_OPEN_DELAY_MS = 5_000;
const MINIMUM_TRADES = 10;
const QUANTITY = 100;

function line(character = "=") {
  console.log(character.repeat(56));
}

function status(label, value) {
  console.log(`${label.padEnd(20, ".")} ${value}`);
}

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env.local");

  if (!fs.existsSync(envPath)) {
    throw new Error("Credentials file .env.local was not found.");
  }

  for (const lineText of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = lineText.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = lineText.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = lineText.slice(0, separator).trim();
    const value = lineText.slice(separator + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  if (!process.env.ALPACA_API_KEY_ID || !process.env.ALPACA_API_SECRET_KEY) {
    throw new Error("Alpaca credentials are missing from .env.local.");
  }
}

async function getJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${label} failed with HTTP ${response.status}.`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${label} timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runPreflight() {
  const account = await getJson(`${PAPER_API}/v2/account`, "Paper account");
  const clock = await getJson(`${PAPER_API}/v2/clock`, "Market clock");
  const asset = await getJson(
    `${PAPER_API}/v2/assets/${encodeURIComponent(SYMBOL)}`,
    "NVDA asset",
  );

  if (account.status !== "ACTIVE") {
    throw new Error(`Paper account is not active (status: ${account.status}).`);
  }
  if (asset.symbol !== SYMBOL || asset.tradable !== true) {
    throw new Error("NVDA was not confirmed as an existing tradable asset.");
  }

  status("REST preflight", "OK");
  status("Account", account.status);
  status("Market clock", clock.is_open ? "OPEN" : "CLOSED");
  status("Asset NVDA", "EXISTS / TRADABLE");
}

async function dataToText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  throw new Error("Unsupported WebSocket message format.");
}

function displayTrades(state) {
  const selected = new Set([
    0,
    state.lastPremarketIndex,
    state.firstRegularIndex,
    state.trades.length - 1,
  ]);

  for (let index = 0; selected.size < MINIMUM_TRADES && index < state.trades.length; index += 1) {
    selected.add(index);
  }

  const indexes = [...selected].filter((index) => index >= 0).sort((a, b) => a - b);

  console.log();
  line("-");
  console.log("LIVE TRADES");
  line("-");

  indexes.forEach((tradeIndex, outputIndex) => {
    const trade = state.trades[tradeIndex];
    let classification = "PREMARKET SIMULADO";

    if (tradeIndex === state.lastPremarketIndex) {
      classification = "ULTIMO PREMARKET";
    } else if (tradeIndex === state.firstRegularIndex) {
      classification = "ABERTURA SIMULADA";
    } else if (tradeIndex > state.firstRegularIndex) {
      classification = "REGULAR SIMULADO";
    }

    const number = String(outputIndex + 1).padStart(2, "0");
    console.log(`${number} | ${trade.price.toFixed(4)} | ${trade.timestamp} | ${classification}`);
  });
}

function calculateAndDisplay(state) {
  const lastPremarket = state.trades[state.lastPremarketIndex];
  const firstRegular = state.trades[state.firstRegularIndex];
  const referencePrice = (lastPremarket.price + firstRegular.price) / 2;
  const dropTrigger = referencePrice * 0.95;
  const entryPrice = referencePrice;
  const takeProfitPrice = referencePrice * 1.1;
  const theoreticalNotional = entryPrice * QUANTITY;

  Object.assign(state, {
    referencePrice,
    dropTrigger,
    entryPrice,
    takeProfitPrice,
    theoreticalNotional,
  });

  console.log();
  line("-");
  console.log("REFERENCE");
  line("-");
  status("Last premarket", lastPremarket.price.toFixed(4));
  status("First regular", firstRegular.price.toFixed(4));
  console.log();
  status(
    "Calculation",
    `(${lastPremarket.price.toFixed(4)} + ${firstRegular.price.toFixed(4)}) / 2`,
  );
  status("Reference", referencePrice.toFixed(4));

  console.log();
  line("-");
  console.log("STRATEGY LEVELS");
  line("-");
  status("Drop trigger -5%", dropTrigger.toFixed(4));
  status("Entry on recovery", entryPrice.toFixed(4));
  status("Take Profit +10%", takeProfitPrice.toFixed(4));
  status("Quantity", `${QUANTITY} shares`);
  status(
    "Notional",
    `${theoreticalNotional.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`,
  );

  console.log();
  line("-");
  console.log("STRATEGY STATE");
  line("-");
  console.log("[OK] Connected");
  console.log("[OK] Authenticated");
  console.log("[OK] Receiving real trades");
  console.log("[OK] Simulated open detected");
  console.log("[OK] Reference calculated");
  console.log();
  console.log(`[ ] Waiting for price <= ${dropTrigger.toFixed(4)}`);
  console.log("[ ] Strategy would become ARMED");
  console.log(`[ ] Waiting for recovery to ${entryPrice.toFixed(4)}`);
  console.log(`[ ] Would send Buy Limit FOK for ${QUANTITY} shares`);
  console.log(`[ ] Would place TP Limit at ${takeProfitPrice.toFixed(4)}`);
  console.log("[ ] Would close any remaining position after 60 seconds");
  console.log();
  console.log("No orders sent.");
  console.log("These strategy states are demonstrative only.");
}

function displaySummary(state) {
  const durationSeconds = (state.observationEndedAt - state.observationStartedAt) / 1000;

  console.log();
  line();
  console.log("PLAYGROUND SUMMARY");
  line();
  status("Trades received", state.trades.length);
  status("Observation time", `${durationSeconds.toFixed(1)} seconds`);
  status("Reference", state.referencePrice.toFixed(4));
  status("Drop trigger", state.dropTrigger.toFixed(4));
  status("Entry", state.entryPrice.toFixed(4));
  status("Take Profit", state.takeProfitPrice.toFixed(4));
  status("Quantity", QUANTITY);
  status("Orders sent", 0);
  status("Positions changed", 0);
  status("Result", "SUCCESS");
}

function runStream() {
  return new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(STREAM_URL);
    const state = {
      authenticated: false,
      subscribed: false,
      completed: false,
      trades: [],
      baseTimestamp: null,
      simulatedOpenMs: null,
      simulatedOpenTimestamp: null,
      lastPremarketIndex: -1,
      firstRegularIndex: -1,
      observationStartedAt: null,
      observationEndedAt: null,
    };
    let observationTimer = null;
    let settled = false;

    const finishWithError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(observationTimer);
      if (socket.readyState === globalThis.WebSocket.OPEN) {
        socket.close(1000, "playground error");
      }
      reject(error);
    };

    socket.addEventListener("open", () => {
      status("WebSocket", "CONNECTED");
      socket.send(
        JSON.stringify({
          action: "auth",
          key: process.env.ALPACA_API_KEY_ID,
          secret: process.env.ALPACA_API_SECRET_KEY,
        }),
      );
    });

    socket.addEventListener("message", async (event) => {
      try {
        const messages = JSON.parse(await dataToText(event.data));

        for (const message of messages) {
          if (message.T === "success" && message.msg === "authenticated") {
            state.authenticated = true;
            status("Authentication", "OK");
            socket.send(JSON.stringify({ action: "subscribe", trades: [SYMBOL] }));
            continue;
          }

          if (
            message.T === "subscription" &&
            Array.isArray(message.trades) &&
            message.trades.includes(SYMBOL)
          ) {
            if (!state.subscribed) {
              state.subscribed = true;
              state.observationStartedAt = Date.now();
              status("Subscription", "OK");
              status("Market data", "WAITING FOR TRADES");
              observationTimer = setTimeout(() => {
                const missing = [];
                if (state.trades.length < MINIMUM_TRADES) {
                  missing.push(`${MINIMUM_TRADES - state.trades.length} additional valid trade(s)`);
                }
                if (state.firstRegularIndex === -1) {
                  missing.push("a trade at or after the simulated open");
                }
                finishWithError(
                  new Error(
                    `Playground timeout after 60 seconds: received ${state.trades.length} valid trade(s); missing ${missing.join(" and ")}.`,
                  ),
                );
              }, STREAM_TIMEOUT_MS);
            }
            continue;
          }

          if (message.T === "error") {
            finishWithError(new Error(`Alpaca WebSocket error ${message.code}: ${message.msg}`));
            return;
          }

          if (message.T !== "t" || !state.subscribed || state.completed) {
            continue;
          }

          const price = Number(message.p);
          const timestampMs = new Date(message.t).getTime();
          if (message.S !== SYMBOL || !Number.isFinite(price) || price <= 0 || !Number.isFinite(timestampMs)) {
            continue;
          }

          if (state.trades.length === 0) {
            state.baseTimestamp = message.t;
            state.simulatedOpenMs = timestampMs + SIMULATED_OPEN_DELAY_MS;
            state.simulatedOpenTimestamp = new Date(state.simulatedOpenMs).toISOString();
            status("Market data", "RECEIVING");
            status("Timestamp base", state.baseTimestamp);
            status("Simulated open", state.simulatedOpenTimestamp);
          }

          const tradeIndex = state.trades.push({ price, timestamp: message.t, timestampMs }) - 1;
          if (timestampMs < state.simulatedOpenMs) {
            state.lastPremarketIndex = tradeIndex;
          } else if (state.firstRegularIndex === -1) {
            state.firstRegularIndex = tradeIndex;
          }

          if (state.trades.length >= MINIMUM_TRADES && state.firstRegularIndex !== -1) {
            state.completed = true;
            state.observationEndedAt = Date.now();
            clearTimeout(observationTimer);
            displayTrades(state);
            calculateAndDisplay(state);
            socket.close(1000, "playground complete");
          }
        }
      } catch (error) {
        finishWithError(error);
      }
    });

    socket.addEventListener("error", () => {
      if (!state.completed) {
        finishWithError(new Error("Native WebSocket emitted a connection error."));
      }
    });

    socket.addEventListener("close", (event) => {
      if (state.completed && !settled) {
        settled = true;
        status("WebSocket close", `${event.code} / ${event.reason || "no reason"}`);
        displaySummary(state);
        resolve(state);
      } else if (!settled) {
        finishWithError(
          new Error(`WebSocket closed before completion (${event.code}: ${event.reason || "no reason"}).`),
        );
      }
    });
  });
}

async function main() {
  line();
  console.log("JSB - PLAYGROUND VISUAL");
  line();
  status("Environment", "PAPER");
  status("Symbol", SYMBOL);
  status("Feed", FEED.toUpperCase());
  status("Orders enabled", "NO");
  console.log();
  status("Status", "STARTING");

  loadLocalEnv();
  await runPreflight();
  await runStream();
}

main().catch((error) => {
  console.error();
  status("Result", "ERROR");
  console.error(error.message);
  console.error("Orders sent: 0");
  console.error("Positions changed: 0");
  process.exitCode = 1;
});
