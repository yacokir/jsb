const fs = require("node:fs");
const path = require("node:path");

const SYMBOL = "NVDA";
const DATA_FEED = "iex";
const REQUEST_TIMEOUT_MS = 10_000;

const TRADING_API_BASE = "https://paper-api.alpaca.markets";
const MARKET_DATA_API_BASE = "https://data.alpaca.markets";

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

async function main() {
  console.log("JSB — Alpaca Stage 01 Preflight\n");
  console.log("Environment: PAPER");
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Market data feed: ${DATA_FEED.toUpperCase()}\n`);

  loadLocalEnv();
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
  console.log("Preflight completed successfully.");
}

main().catch((error) => {
  console.error(`Preflight failed: ${error.message}`);
  process.exitCode = 1;
});
