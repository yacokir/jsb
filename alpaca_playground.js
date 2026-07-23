const ENV_FILE = ".env.local";
const ALPACA_ENVIRONMENT = "PAPER";
const ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
const ACCOUNT_ENDPOINT = `${ALPACA_BASE_URL}/v2/account`;
const POSITIONS_ENDPOINT = `${ALPACA_BASE_URL}/v2/positions`;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const ORDERS_ENABLED = false;

function line(character = "=") {
  console.log(character.repeat(56));
}

function status(label, value) {
  console.log(`${label.padEnd(25, ".")} ${value}`);
}

function yesNo(value) {
  if (typeof value !== "boolean") {
    return "UNKNOWN";
  }
  return value ? "YES" : "NO";
}

function money(value, currency = "USD") {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return value ?? "-";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function percentage(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return value ?? "-";
  }
  return `${(number * 100).toFixed(2)}%`;
}

function loadEnvironment() {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("process.loadEnvFile() is unavailable.");
  }

  process.loadEnvFile(ENV_FILE);
}

function validateConfiguration() {
  if (typeof fetch !== "function") {
    throw new Error("Native fetch is unavailable.");
  }

  if (!process.env.ALPACA_API_KEY_ID?.trim()) {
    throw new Error(`ALPACA_API_KEY_ID is missing from ${ENV_FILE}.`);
  }

  if (!process.env.ALPACA_API_SECRET_KEY?.trim()) {
    throw new Error(`ALPACA_API_SECRET_KEY is missing from ${ENV_FILE}.`);
  }

  if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) {
    throw new Error("Invalid configuration: REQUEST_TIMEOUT_MS must be positive.");
  }
}

async function requestAccount() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ACCOUNT_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      },
      signal: controller.signal,
    });

    const requestId = response.headers.get("x-request-id") ?? "missing";
    const contentType = response.headers.get("content-type") ?? "";

    status("HTTP status", response.status);
    status("Request ID", requestId);
    status("Content-Type", contentType || "missing");

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Alpaca returned invalid JSON: ${error.message}`);
    }

    if (!response.ok) {
      const message = payload?.message ?? "Unknown Alpaca error.";
      throw new Error(`Alpaca HTTP ${response.status}: ${message}`);
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Alpaca request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestPositions() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(POSITIONS_ENDPOINT, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      },
      signal: controller.signal,
    });

    const requestId = response.headers.get("x-request-id") ?? "missing";
    const contentType = response.headers.get("content-type") ?? "";

    status("HTTP status", response.status);
    status("Request ID", requestId);
    status("Content-Type", contentType || "missing");

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Alpaca returned invalid JSON: ${error.message}`);
    }

    if (!response.ok) {
      const message = payload?.message ?? "Unknown Alpaca error.";
      throw new Error(`Alpaca HTTP ${response.status}: ${message}`);
    }

    if (!Array.isArray(payload)) {
      throw new Error("Alpaca positions response is not an array.");
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Alpaca request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function printAccountSummary(account) {
  const currency = account.currency || "USD";

  console.log();
  line();
  console.log("ALPACA PAPER ACCOUNT SUMMARY");
  line();
  status("Account ID", account.id ?? "-");
  status("Account status", account.status ?? "-");
  status("Currency", currency);
  status("Cash", money(account.cash, currency));
  status("Portfolio value", money(account.portfolio_value, currency));
  status("Equity", money(account.equity, currency));
  status("Buying power", money(account.buying_power, currency));
  status(
    "Day-trading buying power",
    money(account.daytrading_buying_power, currency),
  );
  status("Account blocked", yesNo(account.account_blocked));
  status("Trading blocked", yesNo(account.trading_blocked));
  status("Transfers blocked", yesNo(account.transfers_blocked));
  status("Shorting enabled", yesNo(account.shorting_enabled));
  status("Pattern day trader", yesNo(account.pattern_day_trader));
}

function printPositions(positions, currency) {
  console.log();
  line();
  console.log("ALPACA PAPER OPEN POSITIONS");
  line();

  if (positions.length === 0) {
    console.log("Open positions: 0");
    return;
  }

  status("Open positions", positions.length);

  positions.forEach((position, index) => {
    console.log();
    line("-");
    console.log(`OPEN POSITION ${index + 1}`);
    line("-");
    status("Symbol", position.symbol ?? "-");
    status("Quantity", position.qty ?? "-");
    status("Side", position.side ?? "-");
    status("Average entry price", money(position.avg_entry_price, currency));
    status("Current price", money(position.current_price, currency));
    status("Market value", money(position.market_value, currency));
    status("Cost", money(position.cost_basis, currency));
    status("Unrealized PnL", money(position.unrealized_pl, currency));
    status("Unrealized PnL percent", percentage(position.unrealized_plpc));
  });
}

function printFinalSummary(openPositions) {
  console.log();
  line();
  console.log("ALPACA PAPER PLAYGROUND SUMMARY");
  line();
  status("Account query", "OK");
  status("Positions query", "OK");
  status("Open positions", openPositions);
  status("Orders enabled", ORDERS_ENABLED ? "YES" : "NO");
  status("Orders sent", 0);
  status("Result", "SUCCESS");
}

async function main() {
  line();
  console.log("JSB - ALPACA PLAYGROUND / PHASE B - STEP 2");
  line();
  status("Environment", ALPACA_ENVIRONMENT);
  status("Account endpoint", ACCOUNT_ENDPOINT);
  status("Positions endpoint", POSITIONS_ENDPOINT);
  status("Request method", "GET");
  status("Credentials file", ENV_FILE);
  status("Orders enabled", ORDERS_ENABLED ? "YES" : "NO");
  status("Request timeout", `${REQUEST_TIMEOUT_MS / 1000} seconds`);
  console.log();

  loadEnvironment();
  validateConfiguration();
  status("Configuration", "OK");
  status("Credentials loaded", "YES");

  console.log();
  line("-");
  console.log("ACCOUNT REQUEST");
  line("-");
  const account = await requestAccount();
  status("Authentication", "OK");
  status("Account query", "OK");
  printAccountSummary(account);

  console.log();
  line("-");
  console.log("POSITIONS REQUEST");
  line("-");
  const positions = await requestPositions();
  status("Positions query", "OK");
  printPositions(positions, account.currency || "USD");
  printFinalSummary(positions.length);
}

main().catch((error) => {
  console.error();
  line();
  console.log("ALPACA PAPER PLAYGROUND SUMMARY");
  line();
  status("Result", "ERROR");
  status("Operational error", error.message);
  status("Orders sent", 0);
  process.exitCode = 1;
});
