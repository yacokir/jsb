const ENV_FILE = ".env.local";
const ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
const CLIENT_ORDER_ID = "AOT-SELL-1784881856409";
const ORDER_ENDPOINT =
  `${ALPACA_BASE_URL}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(CLIENT_ORDER_ID)}`;
const POSITIONS_ENDPOINT = `${ALPACA_BASE_URL}/v2/positions`;
const OPEN_ORDERS_ENDPOINT =
  `${ALPACA_BASE_URL}/v2/orders?status=open&direction=desc&nested=true&limit=50`;
const REQUEST_TIMEOUT_MS = 10000;
const ORDERS_ENABLED = false;
const POST_REQUESTS = 0;

let getRequests = 0;

function line(character = "=") {
  console.log(character.repeat(64));
}

function status(label, value) {
  console.log(`${label.padEnd(26, ".")} ${value}`);
}

function valueOrDash(value) {
  return value ?? "-";
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

  if (ORDERS_ENABLED || POST_REQUESTS !== 0) {
    throw new Error("This step must remain read-only.");
  }
}

async function requestSellOrder() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  status("Endpoint", ORDER_ENDPOINT);
  status("Method", "GET");

  try {
    getRequests += 1;
    const response = await fetch(ORDER_ENDPOINT, {
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

    if (payload?.client_order_id !== CLIENT_ORDER_ID) {
      throw new Error("Alpaca returned a different Client Order ID.");
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Order lookup timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }

    if (error instanceof TypeError) {
      throw new Error(`Order lookup network error: ${error.message}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestPositions() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  status("Endpoint", POSITIONS_ENDPOINT);
  status("Method", "GET");

  try {
    getRequests += 1;
    const response = await fetch(POSITIONS_ENDPOINT, {
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
      throw new Error("Alpaca positions response is not an array.");
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Positions request timed out after ${REQUEST_TIMEOUT_MS} ms.`,
      );
    }

    if (error instanceof TypeError) {
      throw new Error(`Positions network error: ${error.message}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestOpenOrders() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  status("Endpoint", OPEN_ORDERS_ENDPOINT);
  status("Method", "GET");

  try {
    getRequests += 1;
    const response = await fetch(OPEN_ORDERS_ENDPOINT, {
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
      throw new Error("Alpaca open orders response is not an array.");
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Open orders request timed out after ${REQUEST_TIMEOUT_MS} ms.`,
      );
    }

    if (error instanceof TypeError) {
      throw new Error(`Open orders network error: ${error.message}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  line();
  console.log("AOT - ALPACA ORDER TEST / STEP 7");
  line();

  console.log();
  line("-");
  console.log("CONFIGURATION");
  line("-");
  status("Environment file", ENV_FILE);
  status("Alpaca base URL", ALPACA_BASE_URL);
  status("Client Order ID", CLIENT_ORDER_ID);
  status("Request timeout", `${REQUEST_TIMEOUT_MS} ms`);
  status("Orders enabled", ORDERS_ENABLED ? "YES" : "NO");
  status("POST requests", POST_REQUESTS);

  loadEnvironment();
  validateConfiguration();
  status("Configuration", "OK");
  status("Credentials loaded", "YES");

  console.log();
  line("-");
  console.log("SELL ORDER LOOKUP");
  line("-");
  const sellOrder = await requestSellOrder();
  status("Sell order lookup", "OK");

  console.log();
  line();
  console.log("SELL ORDER DETAILS");
  line();
  status("Order ID", valueOrDash(sellOrder.id));
  status("Client Order ID", valueOrDash(sellOrder.client_order_id));
  status("Symbol", valueOrDash(sellOrder.symbol));
  status("Side", valueOrDash(sellOrder.side));
  status("Type", valueOrDash(sellOrder.type));
  status("Requested quantity", valueOrDash(sellOrder.qty));
  status("Filled quantity", valueOrDash(sellOrder.filled_qty));
  status("Limit price", valueOrDash(sellOrder.limit_price));
  status("Average fill price", valueOrDash(sellOrder.filled_avg_price));
  status("Status", valueOrDash(sellOrder.status));
  status("Submitted at", valueOrDash(sellOrder.submitted_at));
  status("Filled at", valueOrDash(sellOrder.filled_at));
  status("Canceled at", valueOrDash(sellOrder.canceled_at));
  status("Expired at", valueOrDash(sellOrder.expired_at));

  console.log();
  line("-");
  console.log("OPEN POSITIONS LOOKUP");
  line("-");
  const positions = await requestPositions();
  const googPosition = positions.find(
    (position) => position.symbol?.toUpperCase() === "GOOG",
  );
  status("Positions lookup", "OK");

  console.log();
  line();
  console.log("FINAL GOOG STATE");
  line();
  if (googPosition) {
    status("qty", valueOrDash(googPosition.qty));
    status("qty_available", valueOrDash(googPosition.qty_available));
    status("side", valueOrDash(googPosition.side));
    status("avg_entry_price", valueOrDash(googPosition.avg_entry_price));
    status("current_price", valueOrDash(googPosition.current_price));
    status("market_value", valueOrDash(googPosition.market_value));
    status("cost_basis", valueOrDash(googPosition.cost_basis));
    status("unrealized_pl", valueOrDash(googPosition.unrealized_pl));
    status("unrealized_plpc", valueOrDash(googPosition.unrealized_plpc));
  } else {
    status("GOOG position", "CLOSED");
  }

  console.log();
  line("-");
  console.log("OPEN ORDERS LOOKUP");
  line("-");
  const openOrders = await requestOpenOrders();
  const openGoogOrders = openOrders.filter(
    (order) => order.symbol?.toUpperCase() === "GOOG",
  );
  status("Open orders lookup", "OK");
  status("Open GOOG orders", openGoogOrders.length);

  if (openGoogOrders.length > 0) {
    console.log();
    console.log(JSON.stringify(openGoogOrders, null, 2));
  }

  const orderFilled = sellOrder.status === "filled";
  const quantityFilled = Number(sellOrder.filled_qty) === 10;
  const positionClosed = !googPosition;
  const noOpenGoogOrders = openGoogOrders.length === 0;
  const result =
    orderFilled && quantityFilled && positionClosed && noOpenGoogOrders
      ? "SUCCESS"
      : "ERROR";

  console.log();
  line();
  console.log("FINAL SUMMARY");
  line();
  status("Sell order lookup", "OK");
  status("Sell order status", sellOrder.status?.toUpperCase() ?? "-");
  status("Filled quantity", valueOrDash(sellOrder.filled_qty));
  status("Filled average price", valueOrDash(sellOrder.filled_avg_price));
  status("GOOG position", googPosition ? "OPEN" : "CLOSED");
  status("Open GOOG orders", openGoogOrders.length);
  status("POST requests", POST_REQUESTS);
  status("GET requests", getRequests);
  status("Result", result);

  if (result !== "SUCCESS") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error();
  line();
  console.log("FINAL SUMMARY");
  line();
  status("POST requests", POST_REQUESTS);
  status("GET requests", getRequests);
  status("Result", "ERROR");
  status("Operational error", error.message);
  process.exitCode = 1;
});
