const ENV_FILE = ".env.local";
const ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
const REQUEST_TIMEOUT_MS = 10000;
const ORDERS_ENABLED = false;
const ORDERS_SENT = 0;

const OPEN_ORDERS_ENDPOINT =
  `${ALPACA_BASE_URL}/v2/orders?status=open&direction=desc&nested=true&limit=50`;
const CLOSED_ORDERS_ENDPOINT =
  `${ALPACA_BASE_URL}/v2/orders?status=closed&direction=desc&nested=true&limit=20`;

function line(character = "=") {
  console.log(character.repeat(64));
}

function status(label, value) {
  console.log(`${label.padEnd(26, ".")} ${value}`);
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
}

async function requestOrders(endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  status("Endpoint", endpoint);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      },
      signal: controller.signal,
    });

    status("HTTP Status", response.status);
    status("X-Request-ID", response.headers.get("x-request-id") ?? "-");
    status("Content-Type", response.headers.get("content-type") ?? "-");

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Invalid JSON returned by Alpaca: ${error.message}`);
    }

    if (!response.ok) {
      const message = payload?.message ?? "Unknown Alpaca error.";
      throw new Error(`Alpaca HTTP ${response.status}: ${message}`);
    }

    if (!Array.isArray(payload)) {
      throw new Error("Alpaca orders response is not an array.");
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }

    if (error instanceof TypeError) {
      throw new Error(`Network error: ${error.message}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function printOrders(title, orders) {
  console.log();
  line();
  console.log(title);
  line();

  if (orders.length === 0) {
    status(title === "OPEN ORDERS" ? "Open orders" : "Closed orders", 0);
    return;
  }

  orders.forEach((order, index) => {
    if (index > 0) {
      console.log();
    }

    line("-");
    console.log(`ORDER ${index + 1}`);
    line("-");
    status("Order ID", order.id ?? "-");
    status("Client Order ID", order.client_order_id ?? "-");
    status("Symbol", order.symbol ?? "-");
    status("Side", order.side ?? "-");
    status("Type", order.type ?? "-");
    status("Time In Force", order.time_in_force ?? "-");
    status("Requested quantity", order.qty ?? "-");
    status("Filled quantity", order.filled_qty ?? "-");
    status("Limit price", order.limit_price ?? "-");
    status("Stop price", order.stop_price ?? "-");
    status("Average fill price", order.filled_avg_price ?? "-");
    status("Status", order.status ?? "-");
    status("Created at", order.created_at ?? "-");
    status("Submitted at", order.submitted_at ?? "-");
    status("Filled at", order.filled_at ?? "-");
    status("Canceled at", order.canceled_at ?? "-");
    status("Expired at", order.expired_at ?? "-");
  });
}

async function main() {
  line();
  console.log("AOT - ALPACA ORDER TEST / STEP 1");
  line();

  console.log();
  line("-");
  console.log("CONFIGURATION");
  line("-");
  status("Environment file", ENV_FILE);
  status("Alpaca base URL", ALPACA_BASE_URL);
  status("Request timeout", `${REQUEST_TIMEOUT_MS} ms`);
  status("Orders enabled", ORDERS_ENABLED ? "YES" : "NO");
  status("Orders sent", ORDERS_SENT);

  loadEnvironment();
  validateConfiguration();
  status("Configuration", "OK");
  status("Credentials loaded", "YES");

  let openOrders = [];
  let closedOrders = [];
  let openError = null;
  let closedError = null;

  console.log();
  line("-");
  console.log("OPEN ORDERS QUERY");
  line("-");
  try {
    openOrders = await requestOrders(OPEN_ORDERS_ENDPOINT);
    status("Open orders query", "OK");
  } catch (error) {
    openError = error;
    status("Open orders query", "ERROR");
    status("Operational error", error.message);
  }
  printOrders("OPEN ORDERS", openOrders);

  console.log();
  line("-");
  console.log("CLOSED ORDERS QUERY");
  line("-");
  try {
    closedOrders = await requestOrders(CLOSED_ORDERS_ENDPOINT);
    status("Closed orders query", "OK");
  } catch (error) {
    closedError = error;
    status("Closed orders query", "ERROR");
    status("Operational error", error.message);
  }
  printOrders("CLOSED ORDERS", closedOrders);

  console.log();
  line();
  console.log("FINAL SUMMARY");
  line();
  status("Open orders query", openError ? "ERROR" : "OK");
  status("Closed orders query", closedError ? "ERROR" : "OK");
  status("Open orders", openOrders.length);
  status("Closed orders", closedOrders.length);
  status("Orders enabled", ORDERS_ENABLED ? "YES" : "NO");
  status("Orders sent", ORDERS_SENT);
  status("Result", openError || closedError ? "ERROR" : "SUCCESS");

  if (openError || closedError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error();
  line();
  console.log("FINAL SUMMARY");
  line();
  status("Orders enabled", ORDERS_ENABLED ? "YES" : "NO");
  status("Orders sent", ORDERS_SENT);
  status("Result", "ERROR");
  status("Operational error", error.message);
  process.exitCode = 1;
});
