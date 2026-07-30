const ENV_FILE = ".env.local";
const SYMBOL = (process.argv[2]?.trim() ?? "").toUpperCase();
const MODE = (process.argv[3]?.trim() ?? "").toLowerCase();

const QUANTITY = 1;

// Defines how many minutes the BUY STOP-LIMIT may wait for execution before cancellation.
const BUY_ACTIVE_TIMEOUT_MINUTES = 5;
// Defines the total time available for the strategy to arm, submit, and monitor orders.
const STRATEGY_TOTAL_DURATION_MINUTES = 10;

const ARM_DROP_PERCENT = 0.05;
const TAKE_PROFIT_PERCENT = 0.025;
const LIMIT_PERCENT_STPL = 0.01;
const INITIAL_OBSERVATION_MS = 60 * 1000;

const ENTRY_WINDOW_MS = STRATEGY_TOTAL_DURATION_MINUTES * 60 * 1000;
const POSITION_TIMEOUT_MS = 5 * 60 * 1000;

const PRICE_POLL_INTERVAL_MS = 1 * 1000;
const ORDER_POLL_INTERVAL_MS = 1 * 1000;
const ORDER_POLL_TIMEOUT_MS = 30 * 1000;
const BUY_ORDER_ACTIVE_MS = BUY_ACTIVE_TIMEOUT_MINUTES * 60 * 1000;
const HTTP_TIMEOUT_MS = 10 * 1000;

const TEST_SIGNAL_DELAY_MS = 2 * 1000;
// const TEST_EXIT_MODE = "TIMEOUT";
const TEST_EXIT_MODE = "TAKE_PROFIT";

const DATA_FEED = "iex";
const MARKET_TIME_ZONE = "America/New_York";

const REGULAR_MARKET_OPEN_TIME = "09:30";
const REGULAR_MARKET_CLOSE_TIME = "16:00";

const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
const ALPACA_DATA_URL = "https://data.alpaca.markets";

const TERMINAL_ORDER_STATUSES = new Set([
  "canceled",
  "expired",
  "rejected",
  "done_for_day",
  "replaced",
  "suspended",
  "calculated",
]);

const operation = {
  stage: "STARTUP",
  currentClientOrderId: null,
  buyClientOrderId: null,
  sellClientOrderId: null,
  buyMayHaveBeenSent: false,
  sellMayHaveBeenSent: false,
  credentialsLoaded: false,
  regularOpenMs: null,
  regularCloseMs: null,
  buyOrder: null,
  sellOrder: null,
};

const report = {
  openingPrice: null,
  openingTimestamp: null,
  referencePrice: null,
  initialObservationDuration: INITIAL_OBSERVATION_MS,
  armPrice: null,
  buyStopPrice: null,
  buyLimitPrice: null,
  strategyArmed: false,
  armedTimestamp: null,
  armedDuringInitialInterval: false,
  priceAtEndOfInitialInterval: null,
  entryDecision: null,
  armReason: null,
  buyStatus: null,
  buyActiveDurationMs: null,
  buyLastMarketPrice: null,
  buyDistanceToStop: null,
  buyLastTradeAgeSeconds: null,
  buyCancellationConfirmed: null,
  boughtQuantity: null,
  buyAveragePrice: null,
  takeProfitPrice: null,
  exitReason: null,
  soldQuantity: null,
  sellAveragePrice: null,
  grossResult: null,
  finalPosition: null,
  finalOpenOrders: null,
  simulatedSignals: [],
};

function line(character = "=") {
  console.log(character.repeat(72));
}

function section(title) {
  console.log();
  line();
  console.log(title);
  line();
}

function status(label, value) {
  console.log(`${label.padEnd(31, ".")} ${value}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printUsage() {
  console.log("Usage:");
  console.log("  node alop NVDA opening");
  console.log("  node alop NVDA test");
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return number;
}

function timeToMinutes(value, label) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${label} must use HH:MM.`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`${label} is invalid.`);
  }
  return hour * 60 + minute;
}

const marketTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function marketTime(timestampMs = Date.now()) {
  const values = {};
  for (const part of marketTimeFormatter.formatToParts(new Date(timestampMs))) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function validateCommand() {
  if (
    !SYMBOL ||
    !/^[A-Z][A-Z0-9.-]*$/.test(SYMBOL) ||
    !["opening", "test"].includes(MODE)
  ) {
    printUsage();
    process.exitCode = 1;
    return false;
  }
  return true;
}

function validateConfiguration() {
  if (typeof fetch !== "function") {
    throw new Error("Native fetch is unavailable.");
  }
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("process.loadEnvFile() is unavailable.");
  }
  if (ALPACA_PAPER_URL !== "https://paper-api.alpaca.markets") {
    throw new Error("This operator must use Alpaca Paper Trading.");
  }
  if (DATA_FEED !== "iex" || MARKET_TIME_ZONE !== "America/New_York") {
    throw new Error("This operator requires IEX and America/New_York.");
  }
  if (!["TIMEOUT", "TAKE_PROFIT"].includes(TEST_EXIT_MODE)) {
    throw new Error("TEST_EXIT_MODE must be TIMEOUT or TAKE_PROFIT.");
  }

  const positiveParameters = {
    QUANTITY,
    ARM_DROP_PERCENT,
    TAKE_PROFIT_PERCENT,
    LIMIT_PERCENT_STPL,
    BUY_ACTIVE_TIMEOUT_MINUTES,
    STRATEGY_TOTAL_DURATION_MINUTES,
    INITIAL_OBSERVATION_MS,
    ENTRY_WINDOW_MS,
    POSITION_TIMEOUT_MS,
    PRICE_POLL_INTERVAL_MS,
    ORDER_POLL_INTERVAL_MS,
    ORDER_POLL_TIMEOUT_MS,
    HTTP_TIMEOUT_MS,
    TEST_SIGNAL_DELAY_MS,
  };
  for (const [name, value] of Object.entries(positiveParameters)) {
    positiveNumber(value, name);
  }
  if (
    ARM_DROP_PERCENT >= 1 ||
    TAKE_PROFIT_PERCENT >= 1 ||
    LIMIT_PERCENT_STPL >= 1
  ) {
    throw new Error("Strategy percentages must be decimal fractions below 1.");
  }
}

function loadCredentials() {
  process.loadEnvFile(ENV_FILE);
  if (!process.env.ALPACA_API_KEY_ID?.trim()) {
    throw new Error(`ALPACA_API_KEY_ID is missing from ${ENV_FILE}.`);
  }
  if (!process.env.ALPACA_API_SECRET_KEY?.trim()) {
    throw new Error(`ALPACA_API_SECRET_KEY is missing from ${ENV_FILE}.`);
  }
}

async function requestAlpaca(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`Alpaca returned invalid JSON: ${error.message}`);
      }
    }
    if (!response.ok) {
      throw new Error(
        `Alpaca HTTP ${response.status}: ${payload?.message ?? "unknown error"}`,
      );
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        `Alpaca request timed out after ${timeoutMs} ms.`,
      );
      timeoutError.code = "ALPACA_TIMEOUT";
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      throw new Error(`Alpaca network error: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requestAccount() {
  return requestAlpaca(`${ALPACA_PAPER_URL}/v2/account`);
}

function requestClock() {
  return requestAlpaca(`${ALPACA_PAPER_URL}/v2/clock`);
}

function requestAsset() {
  return requestAlpaca(
    `${ALPACA_PAPER_URL}/v2/assets/${encodeURIComponent(SYMBOL)}`,
  );
}

async function requestSymbolPosition() {
  const positions = await requestAlpaca(`${ALPACA_PAPER_URL}/v2/positions`);
  if (!Array.isArray(positions)) {
    throw new Error("Alpaca positions response is not an array.");
  }
  return (
    positions.find(
      (position) => position.symbol?.toUpperCase() === SYMBOL,
    ) ?? null
  );
}

async function requestSymbolOpenOrders() {
  const orders = await requestAlpaca(
    `${ALPACA_PAPER_URL}/v2/orders?status=open&symbols=${encodeURIComponent(SYMBOL)}` +
      "&direction=desc&nested=true&limit=50",
  );
  if (!Array.isArray(orders)) {
    throw new Error("Alpaca open orders response is not an array.");
  }
  return orders.filter((order) => order.symbol?.toUpperCase() === SYMBOL);
}

function requestOrderByClientOrderId(clientOrderId) {
  return requestAlpaca(
    `${ALPACA_PAPER_URL}/v2/orders:by_client_order_id?client_order_id=` +
      encodeURIComponent(clientOrderId),
  );
}

function submitStopLimitBuyOrder(stopPrice, limitPrice, clientOrderId) {
  return requestAlpaca(`${ALPACA_PAPER_URL}/v2/orders`, {
    method: "POST",
    body: {
      symbol: SYMBOL,
      qty: String(QUANTITY),
      side: "buy",
      type: "stop_limit",
      time_in_force: "day",
      stop_price: stopPrice,
      limit_price: limitPrice,
      extended_hours: false,
      client_order_id: clientOrderId,
    },
  });
}

function submitMarketSellOrder(quantity, clientOrderId) {
  return requestAlpaca(`${ALPACA_PAPER_URL}/v2/orders`, {
    method: "POST",
    body: {
      symbol: SYMBOL,
      qty: String(quantity),
      side: "sell",
      type: "market",
      time_in_force: "day",
      extended_hours: false,
      client_order_id: clientOrderId,
    },
  });
}

function cancelOwnBuyOrder(orderId) {
  return requestAlpaca(
    `${ALPACA_PAPER_URL}/v2/orders/${encodeURIComponent(orderId)}`,
    { method: "DELETE" },
  );
}

function createClientOrderId(side) {
  const stamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 17);
  return `ALOP-${MODE.toUpperCase()}-${side.toUpperCase()}-${SYMBOL}-${stamp}`;
}

async function requestLatestAlpacaTrade() {
  const payload = await requestAlpaca(
    `${ALPACA_DATA_URL}/v2/stocks/${encodeURIComponent(SYMBOL)}` +
      `/trades/latest?feed=${encodeURIComponent(DATA_FEED)}`,
  );
  const price = Number(payload?.trade?.p);
  const timestamp = payload?.trade?.t;
  const timestampMs = parseTradeTimestamp(timestamp);
  if (
    payload?.symbol !== SYMBOL ||
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof timestamp !== "string" ||
    !Number.isFinite(timestampMs)
  ) {
    throw new Error("Alpaca returned an invalid latest trade.");
  }
  return { price, timestamp, timestampMs };
}

async function requestFirstRegularTrade(startMs, endMs) {
  const query = new URLSearchParams({
    feed: DATA_FEED,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    sort: "asc",
    limit: "1",
  });
  const remainingMs = Math.max(1, endMs - Date.now());
  let payload;
  try {
    payload = await requestAlpaca(
      `${ALPACA_DATA_URL}/v2/stocks/${encodeURIComponent(SYMBOL)}/trades?${query}`,
      { timeoutMs: Math.min(HTTP_TIMEOUT_MS, remainingMs) },
    );
  } catch (error) {
    if (error.code === "ALPACA_TIMEOUT" && remainingMs <= HTTP_TIMEOUT_MS) {
      return null;
    }
    throw error;
  }

  if (
    payload === null ||
    (typeof payload === "object" &&
      !Array.isArray(payload) &&
      (payload.trades === null || payload.trades === undefined) &&
      Object.keys(payload).every((key) =>
        ["symbol", "trades", "next_page_token"].includes(key),
      ))
  ) {
    return null;
  }
  if (
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.trades) ||
    (payload.symbol !== undefined && payload.symbol !== SYMBOL)
  ) {
    const payloadType =
      payload === null
        ? "null"
        : Array.isArray(payload)
          ? "array"
          : typeof payload;
    const keys =
      payload && typeof payload === "object"
        ? Object.keys(payload).slice(0, 8).join(", ") || "none"
        : "none";
    const tradesType = Array.isArray(payload?.trades)
      ? `array(${payload.trades.length})`
      : payload?.trades === null
        ? "null"
        : typeof payload?.trades;
    throw new Error(
      "Alpaca returned an unexpected historical trades format | " +
        `payload: ${payloadType} | keys: ${keys} | trades: ${tradesType}`,
    );
  }
  if (payload.trades.length === 0) {
    return null;
  }

  const price = Number(payload.trades[0]?.p);
  const timestamp = payload.trades[0]?.t;
  const timestampMs = parseTradeTimestamp(timestamp);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    typeof timestamp !== "string" ||
    !Number.isFinite(timestampMs) ||
    timestampMs < startMs ||
    timestampMs > endMs
  ) {
    return null;
  }

  return { price, timestamp };
}

function parseTradeTimestamp(timestamp) {
  if (typeof timestamp !== "string") {
    return NaN;
  }
  return Date.parse(
    timestamp.replace(
      /\.(\d{3})\d*(Z|[+-]\d{2}:\d{2})$/,
      ".$1$2",
    ),
  );
}

function acceptRegularTrade(trade, sessionDate, tracker) {
  const time = marketTime(trade.timestampMs);
  const regularOpen = timeToMinutes(
    REGULAR_MARKET_OPEN_TIME,
    "REGULAR_MARKET_OPEN_TIME",
  );
  const regularClose = timeToMinutes(
    REGULAR_MARKET_CLOSE_TIME,
    "REGULAR_MARKET_CLOSE_TIME",
  );
  if (
    time.dateKey !== sessionDate ||
    time.minutes < regularOpen ||
    time.minutes >= regularClose ||
    trade.timestamp === tracker.lastTimestamp ||
    (tracker.lastTimestampMs !== null &&
      trade.timestampMs < tracker.lastTimestampMs)
  ) {
    return null;
  }
  tracker.lastTimestamp = trade.timestamp;
  tracker.lastTimestampMs = trade.timestampMs;
  return { ...trade, marketTime: time.time };
}

function roundPrice(price, direction) {
  const decimals = price >= 1 ? 2 : 4;
  const factor = 10 ** decimals;
  let rounded;
  if (direction === "up") {
    rounded = Math.ceil(price * factor - 1e-9) / factor;
  } else if (direction === "down") {
    rounded = Math.floor(price * factor + 1e-9) / factor;
  } else {
    rounded = Math.round(price * factor) / factor;
  }
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new Error("Calculated order price is invalid.");
  }
  return { number: rounded, text: rounded.toFixed(decimals) };
}

function calculateStrategyPrices(referencePrice) {
  const stop = roundPrice(referencePrice, "nearest");
  const rawLimit = referencePrice * (1 + LIMIT_PERCENT_STPL);
  let limit = roundPrice(rawLimit, "up");
  if (limit.number < stop.number) {
    limit = {
      number: stop.number,
      text: stop.text,
    };
  }
  return {
    referencePrice,
    armPrice: referencePrice * (1 - ARM_DROP_PERCENT),
    buyStopPrice: stop,
    buyLimitPrice: limit,
  };
}

function describeOrderStatus(orderStatus) {
  switch (orderStatus?.toLowerCase()) {
    case "pending_new":
      return "received by broker";
    case "new":
      return "accepted and active";
    case "filled":
      return "executed";
    case "canceled":
      return "canceled";
    case "rejected":
      return "rejected";
    default:
      return "status reported by broker";
  }
}

async function pollOrder(
  clientOrderId,
  side,
  externalDeadlineMs = Infinity,
  buyMonitoring = null,
) {
  const isBuy = side.toLowerCase() === "buy";
  const pollingTimeoutMs =
    isBuy ? BUY_ORDER_ACTIVE_MS : ORDER_POLL_TIMEOUT_MS;
  const regularCloseMs =
    isBuy ? Infinity : operation.regularCloseMs ?? Infinity;
  const deadlineMs = Math.min(
    Date.now() + pollingTimeoutMs,
    externalDeadlineMs,
    regularCloseMs,
  );
  let previousStatus = null;
  let lastOrder = null;

  while (Date.now() < deadlineMs) {
    const order = await requestOrderByClientOrderId(clientOrderId);
    lastOrder = order;
    if (order?.client_order_id !== clientOrderId) {
      throw new Error("Alpaca returned a different Client Order ID.");
    }
    const orderStatus = order.status?.toLowerCase();
    if (orderStatus !== previousStatus) {
      status(
        `${side.toUpperCase()} status`,
        `${orderStatus ?? "-"} (${describeOrderStatus(orderStatus)})`,
      );
      status("Filled quantity", order.filled_qty ?? "0");
      previousStatus = orderStatus;
    }

    if (isBuy && buyMonitoring) {
      const trade = await requestLatestAlpacaTrade();
      const accepted = acceptRegularTrade(
        trade,
        buyMonitoring.sessionDate,
        buyMonitoring.tracker,
      );
      if (accepted) {
        buyMonitoring.lastTrade = accepted;
      }
      const lastTrade = buyMonitoring.lastTrade;
      const tradeAgeSeconds = Number.isFinite(lastTrade?.timestampMs)
        ? Math.max(0, Math.floor((Date.now() - lastTrade.timestampMs) / 1000))
        : null;
      const distanceToStop = Number.isFinite(lastTrade?.price)
        ? (lastTrade.price / buyMonitoring.stopPrice - 1) * 100
        : null;
      const tradeAgeText =
        tradeAgeSeconds === null
          ? "Trade age -"
          : tradeAgeSeconds >= 30
            ? `NO TRADE FOR ${tradeAgeSeconds}s`
            : `Trade age ${tradeAgeSeconds}s`;
      console.log(
        `${marketTime().time} ET | ` +
          `Last ${lastTrade?.price?.toFixed(4) ?? "-"} | ` +
          `Stop ${buyMonitoring.stopPrice.toFixed(4)} | ` +
          `Distance ${distanceToStop === null ? "-" : `${distanceToStop >= 0 ? "+" : ""}${distanceToStop.toFixed(2)}%`} | ` +
          `BUY ${orderStatus ?? "-"} (${describeOrderStatus(orderStatus)}) | ` +
          `Filled ${order.filled_qty ?? "0"}/${order.qty ?? QUANTITY} | ` +
          tradeAgeText,
      );
      buyMonitoring.lastMarketPrice = lastTrade?.price ?? null;
      buyMonitoring.distanceToStop = distanceToStop;
      buyMonitoring.lastTradeAgeSeconds = tradeAgeSeconds;
    }

    if (orderStatus === "filled" || TERMINAL_ORDER_STATUSES.has(orderStatus)) {
      return order;
    }
    await delay(
      Math.min(ORDER_POLL_INTERVAL_MS, Math.max(0, deadlineMs - Date.now())),
    );
  }

  const error = new Error(
    `${side.toUpperCase()} polling ended before fill | ` +
      `Client Order ID: ${clientOrderId} | ` +
      `Last status: ${lastOrder?.status ?? "not observed"} | ` +
      `Filled quantity: ${lastOrder?.filled_qty ?? "not observed"}`,
  );
  if (isBuy && Number.isFinite(buyMonitoring?.lastTrade?.timestampMs)) {
    buyMonitoring.lastTradeAgeSeconds = Math.max(
      0,
      Math.floor(
        (Date.now() - buyMonitoring.lastTrade.timestampMs) / 1000,
      ),
    );
  }
  error.code = "ORDER_POLL_TIMEOUT";
  error.lastOrder = lastOrder;
  error.buyMonitoring = buyMonitoring;
  throw error;
}

async function inspectSymbol(title, safe = false) {
  section(title);
  let position = null;
  let openOrders = [];
  let positionKnown = false;
  let ordersKnown = false;
  const errors = [];

  try {
    position = await requestSymbolPosition();
    positionKnown = true;
  } catch (error) {
    if (!safe) throw error;
    errors.push(`Position query: ${error.message}`);
  }
  try {
    openOrders = await requestSymbolOpenOrders();
    ordersKnown = true;
  } catch (error) {
    if (!safe) throw error;
    errors.push(`Open orders query: ${error.message}`);
  }

  status("Position", positionKnown ? position?.qty ?? "0" : "UNKNOWN");
  status(
    "Quantity available",
    positionKnown ? position?.qty_available ?? "0" : "UNKNOWN",
  );
  status("Open orders", ordersKnown ? openOrders.length : "UNKNOWN");
  if (ordersKnown) {
    for (const order of openOrders) {
      console.log(
        `Order | ${order.side ?? "-"} | ${order.status ?? "-"} | ` +
          `qty ${order.qty ?? "-"} | filled ${order.filled_qty ?? "0"} | ` +
          `${order.client_order_id ?? order.id ?? "-"}`,
      );
    }
  }
  for (const message of errors) {
    status("Inspection error", message);
  }
  return { position, openOrders, positionKnown, ordersKnown, errors };
}

function printOriginalError(error) {
  section("ORIGINAL OPERATIONAL ERROR");
  status("Mode", MODE || "-");
  status("Symbol", SYMBOL || "-");
  status("Stage", operation.stage);
  status("Client Order ID", operation.currentClientOrderId ?? "-");
  status("Error", error.message);
}

function printCriticalWarning(error, state, buyOrder, sellOrder) {
  console.error();
  console.error("!".repeat(76));
  console.error("CRITICAL WARNING — MANUAL ACTION REQUIRED");
  console.error("!".repeat(76));
  status("Mode", MODE);
  status("Symbol", SYMBOL);
  status("Stage", operation.stage);
  status("Original error", error.message);
  status("BUY Client Order ID", operation.buyClientOrderId ?? "-");
  status("SELL Client Order ID", operation.sellClientOrderId ?? "-");
  status(
    "Known position",
    state.positionKnown ? state.position?.qty ?? "0" : "UNKNOWN",
  );
  status(
    "Quantity available",
    state.positionKnown
      ? state.position?.qty_available ?? "0"
      : "UNKNOWN",
  );
  status(
    "Open orders",
    state.ordersKnown ? state.openOrders.length : "UNKNOWN",
  );
  status("Known BUY status", buyOrder?.status ?? "UNKNOWN");
  status("Known SELL status", sellOrder?.status ?? "UNKNOWN");
  if (state.ordersKnown) {
    for (const order of state.openOrders) {
      console.error(
        `Order | ${order.side ?? "-"} | ${order.status ?? "-"} | ` +
          `${order.client_order_id ?? order.id ?? "-"}`,
      );
    }
  }
  console.error(
    `Verify ${SYMBOL} immediately in the Alpaca Paper account and resolve any position or open order.`,
  );
  console.error("!".repeat(76));
  process.exitCode = 1;
}

async function waitUntilOwnBuyIsClosed(clientOrderId) {
  const deadlineMs = Date.now() + ORDER_POLL_TIMEOUT_MS;
  let orders = [];
  while (Date.now() < deadlineMs) {
    orders = await requestSymbolOpenOrders();
    if (!orders.some((order) => order.client_order_id === clientOrderId)) {
      return orders;
    }
    await delay(
      Math.min(ORDER_POLL_INTERVAL_MS, Math.max(0, deadlineMs - Date.now())),
    );
  }
  return orders;
}

async function resolveBuyFailure(originalError, lastOrder) {
  let buyOrder = lastOrder;
  let cancellationRequested = false;
  let cancellationError = null;
  try {
    buyOrder = await requestOrderByClientOrderId(operation.buyClientOrderId);
  } catch (error) {
    status("BUY lookup error", error.message);
  }

  let state = await inspectSymbol("BUY STATE AFTER FAILURE", true);
  const ownOpenBuy = state.ordersKnown
    ? state.openOrders.find(
        (order) =>
          order.side === "buy" &&
          order.client_order_id === operation.buyClientOrderId,
      )
    : null;

  if (ownOpenBuy) {
    section("CANCEL OWN BUY");
    status("Client Order ID", ownOpenBuy.client_order_id);
    status("Order ID", ownOpenBuy.id);
    try {
      await cancelOwnBuyOrder(ownOpenBuy.id);
      cancellationRequested = true;
      status("Cancel request", "SENT ONCE");
      const remaining = await waitUntilOwnBuyIsClosed(
        operation.buyClientOrderId,
      );
      status(
        "BUY still open",
        remaining.some(
          (order) =>
            order.client_order_id === operation.buyClientOrderId,
        )
          ? "YES"
          : "NO",
      );
    } catch (error) {
      cancellationError = error;
      status("Cancel error", error.message);
    }
  }

  try {
    buyOrder = await requestOrderByClientOrderId(operation.buyClientOrderId);
  } catch (error) {
    status("Final BUY lookup error", error.message);
  }
  state = await inspectSymbol("STATE AFTER BUY RESOLUTION", true);
  const clean =
    state.positionKnown &&
    !state.position &&
    state.ordersKnown &&
    state.openOrders.length === 0;
  const buyStillOpen =
    state.ordersKnown &&
    state.openOrders.some(
      (order) =>
        order.side === "buy" &&
        order.client_order_id === operation.buyClientOrderId,
    );
  const observedFill = Number(buyOrder?.filled_qty ?? 0);
  const cancellationConfirmed =
    cancellationRequested && state.ordersKnown && !buyStillOpen;

  if (cancellationError) {
    printCriticalWarning(cancellationError, state, buyOrder, null);
    return {
      result: "CRITICAL",
      buyOrder,
      position: null,
      state,
      cancellationConfirmed: false,
    };
  }

  if (clean && observedFill <= 0) {
    return {
      result: "NO BUY FILL",
      buyOrder,
      position: null,
      state,
      cancellationConfirmed,
    };
  }
  if (
    state.positionKnown &&
    state.position &&
    state.ordersKnown &&
    !buyStillOpen &&
    state.openOrders.length === 0
  ) {
    return {
      result: "POSITION",
      buyOrder,
      position: state.position,
      state,
      cancellationConfirmed,
    };
  }

  printCriticalWarning(originalError, state, buyOrder, null);
  return {
    result: "CRITICAL",
    buyOrder,
    position: null,
    state,
    cancellationConfirmed,
  };
}

async function finishWithoutPosition(result, reason) {
  section("NO POSITION RESULT");
  status("Reason", reason);
  const state = await inspectSymbol("FINAL VERIFICATION", true);
  const clean =
    state.positionKnown &&
    !state.position &&
    state.ordersKnown &&
    state.openOrders.length === 0;
  if (!clean) {
    printCriticalWarning(new Error(reason), state, operation.buyOrder, null);
    return;
  }
  report.finalPosition = "0";
  report.finalOpenOrders = 0;
  printOperationReport(state);
  status("Result", result);
}

function validateAccountAndAsset(account, asset) {
  if (account?.status !== "ACTIVE") {
    throw new Error(`Paper account is not active (${account?.status ?? "unknown"}).`);
  }
  if (account.trading_blocked !== false || account.account_blocked === true) {
    throw new Error("Trading is blocked on the Alpaca Paper account.");
  }
  positiveNumber(account.buying_power, "Account buying power");
  if (
    asset?.symbol?.toUpperCase() !== SYMBOL ||
    asset.status !== "active" ||
    asset.tradable !== true
  ) {
    throw new Error(`${SYMBOL} is not an active tradable asset.`);
  }
}

async function validateRegularMarket() {
  const now = marketTime();
  const regularOpen = timeToMinutes(
    REGULAR_MARKET_OPEN_TIME,
    "REGULAR_MARKET_OPEN_TIME",
  );
  const regularClose = timeToMinutes(
    REGULAR_MARKET_CLOSE_TIME,
    "REGULAR_MARKET_CLOSE_TIME",
  );
  const clock = await requestClock();
  if (
    clock?.is_open !== true ||
    now.minutes < regularOpen ||
    now.minutes >= regularClose
  ) {
    throw new Error("Regular market must be open between 09:30 and 16:00 ET.");
  }
  const closeMs = Date.parse(clock.next_close);
  if (!Number.isFinite(closeMs)) {
    throw new Error("Alpaca returned an invalid regular close.");
  }
  operation.regularCloseMs = closeMs;
  return clock;
}

async function initialValidation() {
  operation.stage = "INITIAL VALIDATION";
  const [account, clock, asset, state] = await Promise.all([
    requestAccount(),
    requestClock(),
    requestAsset(),
    inspectSymbol("INITIAL SYMBOL STATE"),
  ]);
  validateAccountAndAsset(account, asset);
  if (state.position || state.openOrders.length > 0) {
    throw new Error(`${SYMBOL} must start with position zero and open orders zero.`);
  }

  const now = marketTime();
  const regularOpen = timeToMinutes(
    REGULAR_MARKET_OPEN_TIME,
    "REGULAR_MARKET_OPEN_TIME",
  );
  const regularClose = timeToMinutes(
    REGULAR_MARKET_CLOSE_TIME,
    "REGULAR_MARKET_CLOSE_TIME",
  );

  if (MODE === "opening") {
    if (now.minutes >= regularOpen) {
      throw new Error("OPENING MODE MUST START BEFORE 09:30 ET");
    }
    const nextOpenMs = Date.parse(clock.next_open);
    const nextCloseMs = Date.parse(clock.next_close);
    if (
      !Number.isFinite(nextOpenMs) ||
      !Number.isFinite(nextCloseMs) ||
      marketTime(nextOpenMs).dateKey !== now.dateKey
    ) {
      throw new Error("Opening mode requires the current market day.");
    }
    operation.regularOpenMs = nextOpenMs;
    operation.regularCloseMs = nextCloseMs;
  } else {
    if (
      now.minutes < regularOpen ||
      now.minutes >= regularClose ||
      clock.is_open !== true
    ) {
      throw new Error("TEST MODE REQUIRES OPEN REGULAR MARKET 09:30-16:00 ET");
    }
    const nextCloseMs = Date.parse(clock.next_close);
    if (!Number.isFinite(nextCloseMs)) {
      throw new Error("Alpaca returned an invalid regular close.");
    }
    operation.regularCloseMs = nextCloseMs;
  }

  status("Account", "ACTIVE / TRADING ENABLED");
  status("Asset", "ACTIVE / TRADABLE");
  status("Initial state", "POSITION 0 / OPEN ORDERS 0");
  return { account, clock, sessionDate: now.dateKey };
}

async function prepareOpeningSignals(sessionDate) {
  operation.stage = "WAITING FOR REGULAR OPEN";
  section("WAITING FOR REGULAR OPEN");
  const regularOpen = timeToMinutes(
    REGULAR_MARKET_OPEN_TIME,
    "REGULAR_MARKET_OPEN_TIME",
  );
  while (marketTime().minutes < regularOpen) {
    await delay(PRICE_POLL_INTERVAL_MS);
  }

  operation.stage = "OPENING TRADE";
  section("OPENING TRADE");
  const historicalEndMs = operation.regularOpenMs + 60 * 1000;
  let firstRegularTrade = null;
  while (
    Date.now() < historicalEndMs &&
    Date.now() < operation.regularCloseMs &&
    !firstRegularTrade
  ) {
    firstRegularTrade = await requestFirstRegularTrade(
      operation.regularOpenMs,
      historicalEndMs,
    );
    if (!firstRegularTrade) {
      await delay(PRICE_POLL_INTERVAL_MS);
    }
  }
  const openingCapturedAtMs = Date.now();
  const openingTimestampMs = firstRegularTrade
    ? parseTradeTimestamp(firstRegularTrade.timestamp)
    : null;
  const tracker = {
    lastTimestamp: firstRegularTrade?.timestamp ?? null,
    lastTimestampMs: openingTimestampMs,
  };
  const openingTrade = firstRegularTrade
    ? {
        ...firstRegularTrade,
        timestampMs: openingTimestampMs,
        marketTime: marketTime(openingTimestampMs).time,
      }
    : null;
  if (!openingTrade) {
    status(
      "Opening trade",
      "NOT AVAILABLE BETWEEN 09:30:00 AND 09:31:00 ET",
    );
    return null;
  }

  status("Opening price", openingTrade.price.toFixed(4));
  status("Opening timestamp", openingTrade.timestamp);
  status("Opening time ET", openingTrade.marketTime);
  status("Reference price", openingTrade.price.toFixed(4));

  return {
    openingPrice: openingTrade.price,
    openingTimestamp: openingTrade.timestamp,
    referencePrice: openingTrade.price,
    entryWindowStartedAtMs: openingCapturedAtMs,
    tracker,
    sessionDate,
    lastTrade: openingTrade,
  };
}

async function prepareTestSignals(sessionDate) {
  operation.stage = "TEST REFERENCE";
  section("TEST REAL REFERENCE");
  const tracker = { lastTimestamp: null, lastTimestampMs: null };
  let realTrade = null;
  while (Date.now() < operation.regularCloseMs && !realTrade) {
    const cycleStartedAt = Date.now();
    const trade = await requestLatestAlpacaTrade();
    realTrade = acceptRegularTrade(trade, sessionDate, tracker);
    if (!realTrade) {
      const elapsed = Date.now() - cycleStartedAt;
      await delay(Math.max(0, PRICE_POLL_INTERVAL_MS - elapsed));
    }
  }
  if (!realTrade) {
    return null;
  }
  const capturedAtMs = Date.now();
  status("Initial real price", realTrade.price.toFixed(4));
  status("Real timestamp", realTrade.timestamp);
  status("Opening price", realTrade.price.toFixed(4));
  status("Reference price", realTrade.price.toFixed(4));
  return {
    openingPrice: realTrade.price,
    openingTimestamp: realTrade.timestamp,
    referencePrice: realTrade.price,
    entryWindowStartedAtMs: capturedAtMs,
    tracker,
    sessionDate,
    lastTrade: realTrade,
  };
}

function printStrategySetup(setup, signalState, entryDeadlineMs) {
  section("STRATEGY SETUP");
  status("Opening price", signalState.openingPrice.toFixed(4));
  status("Opening timestamp", signalState.openingTimestamp);
  status("Reference price", setup.referencePrice.toFixed(4));
  status(
    "Initial observation duration",
    `${INITIAL_OBSERVATION_MS / 1000} seconds`,
  );
  status("ARM_DROP_PERCENT", `${ARM_DROP_PERCENT * 100}%`);
  status("Arm price", setup.armPrice.toFixed(4));
  status("BUY Stop", setup.buyStopPrice.text);
  status("LIMIT_PERCENT_STPL", `${LIMIT_PERCENT_STPL * 100}%`);
  status("BUY Limit", setup.buyLimitPrice.text);
  status("TAKE_PROFIT_PERCENT", `${TAKE_PROFIT_PERCENT * 100}%`);
  status("Entry deadline", new Date(entryDeadlineMs).toISOString());
}

function registerArm(price, timestamp, duringInitialInterval, reason) {
  const distance = (price / report.openingPrice - 1) * 100;
  report.strategyArmed = true;
  report.armedTimestamp = timestamp;
  report.armedDuringInitialInterval = duringInitialInterval;
  report.armReason = reason;
  status(
    "Strategy state",
    duringInitialInterval
      ? "ARMED DURING INITIAL INTERVAL"
      : "ARMED AFTER INITIAL INTERVAL",
  );
  status("Armed price", price.toFixed(4));
  status("Armed timestamp", timestamp);
  status("Distance from opening", `${distance.toFixed(4)}%`);
}

async function determineEntryDecision(setup, signalState, entryDeadlineMs) {
  if (MODE === "test") {
    operation.stage = "SIMULATED INITIAL INTERVAL";
    section("SIMULATED INITIAL INTERVAL");
    const simulatedStart = Date.now();
    status("Initial observation start", new Date(simulatedStart).toISOString());
    status(
      "Configured real duration",
      `${INITIAL_OBSERVATION_MS / 1000} seconds`,
    );
    status("Simulation step delay", `${TEST_SIGNAL_DELAY_MS / 1000} seconds`);

    await delay(TEST_SIGNAL_DELAY_MS);
    const simulatedArmPrice = setup.armPrice * 0.999;
    section("SIMULATED ARM SIGNAL");
    status("Simulated price", simulatedArmPrice.toFixed(4));
    status("Real order impact", "NONE");
    status("Signal source", "SIMULATED — NOT A REAL TRADE");
    registerArm(
      simulatedArmPrice,
      new Date().toISOString(),
      true,
      "SIMULATED ARM DURING INITIAL INTERVAL",
    );
    report.simulatedSignals.push(`ARM ${simulatedArmPrice.toFixed(4)}`);

    await delay(TEST_SIGNAL_DELAY_MS);
    const simulatedEndPrice = setup.armPrice * 1.001;
    report.priceAtEndOfInitialInterval = simulatedEndPrice;
    report.entryDecision =
      "ARMED DURING INITIAL INTERVAL — ORDER SENT AFTER INTERVAL";
    section("SIMULATED END-OF-INTERVAL PRICE");
    status("Simulated price", simulatedEndPrice.toFixed(4));
    status("Opening price", signalState.openingPrice.toFixed(4));
    status("Still at or below opening", "YES");
    status("Real order impact", "TRIGGER REAL BUY STOP-LIMIT SUBMISSION");
    status("Initial observation end", new Date().toISOString());
    report.simulatedSignals.push(
      `END INTERVAL ${simulatedEndPrice.toFixed(4)}`,
    );
    return { sendOrder: true, reason: report.entryDecision };
  }

  const initialObservationStartedAtMs =
    signalState.entryWindowStartedAtMs;
  const initialObservationEndMs =
    initialObservationStartedAtMs + INITIAL_OBSERVATION_MS;
  let lastTrade = signalState.lastTrade;
  let armedDuringInitialInterval = false;

  operation.stage = "INITIAL OBSERVATION";
  section("INITIAL OBSERVATION");
  status("Strategy state", "INITIAL OBSERVATION — NOT ELIGIBLE TO ENTER");
  status(
    "Initial observation start",
    new Date(initialObservationStartedAtMs).toISOString(),
  );
  status(
    "Initial observation end",
    new Date(initialObservationEndMs).toISOString(),
  );

  while (
    Date.now() < initialObservationEndMs &&
    Date.now() < entryDeadlineMs &&
    Date.now() < operation.regularCloseMs
  ) {
    const cycleStartedAt = Date.now();
    const trade = await requestLatestAlpacaTrade();
    const accepted = acceptRegularTrade(
      trade,
      signalState.sessionDate,
      signalState.tracker,
    );
    if (accepted) {
      lastTrade = accepted;
      console.log(
        `${accepted.marketTime} ET | Real price ${accepted.price.toFixed(4)} | ` +
          `${armedDuringInitialInterval ? "ARMED DURING INITIAL INTERVAL" : "NOT ELIGIBLE TO ENTER"}`,
      );
      if (!armedDuringInitialInterval && accepted.price <= setup.armPrice) {
        armedDuringInitialInterval = true;
        section("STRATEGY ARMED");
        registerArm(
          accepted.price,
          accepted.timestamp,
          true,
          "REAL ARM DURING INITIAL INTERVAL",
        );
        status("Order submission", "BLOCKED UNTIL INITIAL INTERVAL ENDS");
      }
    }
    const elapsed = Date.now() - cycleStartedAt;
    await delay(Math.max(0, PRICE_POLL_INTERVAL_MS - elapsed));
  }

  report.priceAtEndOfInitialInterval = lastTrade.price;
  section("END OF INITIAL OBSERVATION");
  status("Last real price", lastTrade.price.toFixed(4));
  status("Opening price", signalState.openingPrice.toFixed(4));
  status("Strategy armed", armedDuringInitialInterval ? "YES" : "NO");

  if (
    armedDuringInitialInterval &&
    lastTrade.price <= signalState.openingPrice
  ) {
    report.entryDecision =
      "ARMED DURING INITIAL INTERVAL — ORDER SENT AFTER INTERVAL";
    status(
      "Order reason",
      "ARMED DURING INITIAL INTERVAL — PRICE STILL AT OR BELOW OPEN",
    );
    status("Entry decision", report.entryDecision);
    return { sendOrder: true, reason: report.entryDecision };
  }

  if (
    armedDuringInitialInterval &&
    lastTrade.price > signalState.openingPrice
  ) {
    report.entryDecision =
      "ENTRY ABORTED — PRICE RECOVERED ABOVE OPEN DURING INITIAL INTERVAL";
    section("ENTRY ABORTED — PRICE RECOVERED ABOVE OPEN DURING INITIAL INTERVAL");
    status("Entry decision", report.entryDecision);
    return { sendOrder: false, aborted: true, reason: report.entryDecision };
  }

  operation.stage = "WAITING FOR ARM";
  section("ENTRY MONITORING");
  status("Strategy state", "WAITING FOR ARM");
  while (
    Date.now() < entryDeadlineMs &&
    Date.now() < operation.regularCloseMs
  ) {
    const cycleStartedAt = Date.now();
    const trade = await requestLatestAlpacaTrade();
    const accepted = acceptRegularTrade(
      trade,
      signalState.sessionDate,
      signalState.tracker,
    );
    if (accepted) {
      lastTrade = accepted;
      const distanceToArm =
        (accepted.price / setup.armPrice - 1) * 100;
      console.log(
        `${accepted.marketTime} ET | ` +
          `Last ${accepted.price.toFixed(4)} | ` +
          `Arm ${setup.armPrice.toFixed(4)} | ` +
          `Distance ${distanceToArm >= 0 ? "+" : ""}${distanceToArm.toFixed(2)}% | ` +
          "WAITING FOR ARM",
      );
      if (accepted.price <= setup.armPrice) {
        section("STRATEGY ARMED");
        registerArm(
          accepted.price,
          accepted.timestamp,
          false,
          "REAL ARM AFTER INITIAL INTERVAL",
        );
        report.entryDecision = "ARMED AFTER INITIAL INTERVAL — ORDER SENT";
        status("Entry decision", report.entryDecision);
        return { sendOrder: true, reason: report.entryDecision };
      }
    }
    const elapsed = Date.now() - cycleStartedAt;
    await delay(Math.max(0, PRICE_POLL_INTERVAL_MS - elapsed));
  }

  report.entryDecision = "NEVER ARMED";
  status("Entry decision", report.entryDecision);
  return { sendOrder: false, aborted: false, reason: report.entryDecision };
}

function printBuyTimeoutResult(timeoutError, resolution, activeDurationMs) {
  const monitoring = timeoutError.buyMonitoring;
  const lastOrder = timeoutError.lastOrder;
  const finalStatus = resolution.buyOrder?.status ?? "UNKNOWN";
  const activeSeconds = Math.round(activeDurationMs / 1000);

  section("BUY TIMEOUT — NO FILL");
  status(
    "Active duration",
    activeSeconds % 60 === 0
      ? `${activeSeconds / 60} minutes`
      : `${activeSeconds} seconds`,
  );
  status(
    "Last status before cancel",
    `${lastOrder?.status ?? "UNKNOWN"} (${describeOrderStatus(lastOrder?.status)})`,
  );
  status("Filled quantity", lastOrder?.filled_qty ?? "0");
  status(
    "Last market price",
    monitoring?.lastMarketPrice?.toFixed(4) ?? "-",
  );
  status(
    "Distance to stop",
    Number.isFinite(monitoring?.distanceToStop)
      ? `${monitoring.distanceToStop >= 0 ? "+" : ""}${monitoring.distanceToStop.toFixed(2)}%`
      : "-",
  );
  status(
    "Last trade age",
    Number.isFinite(monitoring?.lastTradeAgeSeconds)
      ? `${monitoring.lastTradeAgeSeconds} seconds`
      : "-",
  );
  status(
    "Final BUY status",
    `${finalStatus} (${describeOrderStatus(finalStatus)})`,
  );
  status(
    "Cancellation",
    resolution.cancellationConfirmed ? "CONFIRMED" : "NOT CONFIRMED",
  );
  status(
    "Final position",
    resolution.state?.positionKnown
      ? resolution.state.position?.qty ?? "0"
      : "UNKNOWN",
  );
  status(
    "Final open orders",
    resolution.state?.ordersKnown
      ? resolution.state.openOrders.length
      : "UNKNOWN",
  );
}

async function executeBuy(setup, signalState) {
  await validateRegularMarket();
  const clientOrderId = createClientOrderId("buy");
  operation.stage = "SUBMITTING BUY STOP-LIMIT";
  operation.currentClientOrderId = clientOrderId;
  operation.buyClientOrderId = clientOrderId;
  operation.buyMayHaveBeenSent = true;

  section("BUY STOP-LIMIT");
  status("Symbol", SYMBOL);
  status("Quantity", QUANTITY);
  status("Stop price", setup.buyStopPrice.text);
  status("Limit price", setup.buyLimitPrice.text);
  status("Client Order ID", clientOrderId);
  const buySubmittedAtMs = Date.now();
  const buyDeadlineMs = buySubmittedAtMs + BUY_ORDER_ACTIVE_MS;
  const buyMonitoring = {
    sessionDate: signalState.sessionDate,
    tracker: signalState.tracker,
    lastTrade: signalState.lastTrade,
    stopPrice: setup.buyStopPrice.number,
    lastMarketPrice: signalState.lastTrade?.price ?? null,
    distanceToStop: Number.isFinite(signalState.lastTrade?.price)
      ? (signalState.lastTrade.price / setup.buyStopPrice.number - 1) * 100
      : null,
    lastTradeAgeSeconds: Number.isFinite(signalState.lastTrade?.timestampMs)
      ? Math.max(
          0,
          Math.floor(
            (buySubmittedAtMs - signalState.lastTrade.timestampMs) / 1000,
          ),
        )
      : null,
  };
  status("BUY active deadline", new Date(buyDeadlineMs).toISOString());
  await submitStopLimitBuyOrder(
    setup.buyStopPrice.text,
    setup.buyLimitPrice.text,
    clientOrderId,
  );

  operation.stage = "POLLING BUY STOP-LIMIT";
  try {
    const order = await pollOrder(
      clientOrderId,
      "buy",
      buyDeadlineMs,
      buyMonitoring,
    );
    operation.buyOrder = order;
    report.buyStatus = order.status;
    if (order.status !== "filled") {
      throw new Error(
        `BUY ended with status ${order.status ?? "unknown"} | ` +
          `Filled quantity: ${order.filled_qty ?? "0"}`,
      );
    }
    const position = await requestSymbolPosition();
    if (!position) {
      throw new Error("BUY filled, but the real position was not confirmed.");
    }
    return { result: "POSITION", buyOrder: order, position };
  } catch (error) {
    const isExpectedBuyTimeout = error.code === "ORDER_POLL_TIMEOUT";
    if (!isExpectedBuyTimeout) {
      printOriginalError(error);
    }
    const resolution = await resolveBuyFailure(
      error,
      error.lastOrder ?? operation.buyOrder,
    );
    operation.buyOrder = resolution.buyOrder;
    report.buyStatus = resolution.buyOrder?.status ?? "UNKNOWN";
    if (isExpectedBuyTimeout && resolution.result === "NO BUY FILL") {
      const activeDurationMs = Math.min(
        BUY_ORDER_ACTIVE_MS,
        Math.max(0, Date.now() - buySubmittedAtMs),
      );
      report.buyActiveDurationMs = activeDurationMs;
      report.buyLastMarketPrice = buyMonitoring.lastMarketPrice;
      report.buyDistanceToStop = buyMonitoring.distanceToStop;
      report.buyLastTradeAgeSeconds = buyMonitoring.lastTradeAgeSeconds;
      report.buyCancellationConfirmed = resolution.cancellationConfirmed;
      printBuyTimeoutResult(error, resolution, activeDurationMs);
      resolution.buyTimedOut = true;
    }
    return resolution;
  }
}

function officialBuyDetails(buyOrder, position) {
  const quantity = positiveNumber(position.qty, "Real position quantity");
  const averagePrice = positiveNumber(
    buyOrder?.filled_avg_price ?? position.avg_entry_price,
    "Real buy average price",
  );
  report.boughtQuantity = quantity;
  report.buyAveragePrice = averagePrice;
  report.buyStatus = buyOrder?.status ?? report.buyStatus ?? "UNKNOWN";
  report.takeProfitPrice = averagePrice * (1 + TAKE_PROFIT_PERCENT);
  const filledAtMs = parseTradeTimestamp(buyOrder?.filled_at);
  return {
    quantity,
    averagePrice,
    filledAtMs: Number.isFinite(filledAtMs) ? filledAtMs : Date.now(),
  };
}

async function determineExitReason(buyDetails, signalState) {
  const positionDeadlineMs =
    buyDetails.filledAtMs + POSITION_TIMEOUT_MS;

  if (MODE === "test" && TEST_EXIT_MODE === "TIMEOUT") {
    operation.stage = "TEST POSITION TIMEOUT";
    await delay(Math.max(0, positionDeadlineMs - Date.now()));
    return "TEST POSITION TIMEOUT";
  }

  if (MODE === "test" && TEST_EXIT_MODE === "TAKE_PROFIT") {
    operation.stage = "SIMULATED TAKE PROFIT SIGNAL";
    await delay(TEST_SIGNAL_DELAY_MS);
    const simulatedTakeProfitPrice = report.takeProfitPrice * 1.001;
    section("SIMULATED TAKE PROFIT SIGNAL");
    status("Simulated price", simulatedTakeProfitPrice.toFixed(4));
    status("Real order impact", "TRIGGER SELL LOGIC");
    status("Signal source", "SIMULATED — NOT A REAL TRADE");
    report.simulatedSignals.push(
      `TAKE PROFIT ${simulatedTakeProfitPrice.toFixed(4)}`,
    );
    return "SIMULATED TAKE PROFIT SIGNAL";
  }

  operation.stage = "REAL EXIT MONITORING";
  section("REAL EXIT MONITORING");
  status("Take profit", report.takeProfitPrice.toFixed(4));
  status("Position deadline", new Date(positionDeadlineMs).toISOString());
  while (
    Date.now() < positionDeadlineMs &&
    Date.now() < operation.regularCloseMs
  ) {
    const cycleStartedAt = Date.now();
    const trade = await requestLatestAlpacaTrade();
    const accepted = acceptRegularTrade(
      trade,
      signalState.sessionDate,
      signalState.tracker,
    );
    if (accepted && accepted.timestampMs >= buyDetails.filledAtMs) {
      console.log(
        `${accepted.marketTime} ET | Real price ${accepted.price.toFixed(4)} | ` +
          `TP ${report.takeProfitPrice.toFixed(4)}`,
      );
      if (accepted.price >= report.takeProfitPrice) {
        return "TAKE PROFIT";
      }
    }
    const elapsed = Date.now() - cycleStartedAt;
    await delay(Math.max(0, PRICE_POLL_INTERVAL_MS - elapsed));
  }
  return "POSITION TIMEOUT";
}

async function handleSellFailure(originalError, lastOrder) {
  let sellOrder = lastOrder;
  try {
    sellOrder = await requestOrderByClientOrderId(operation.sellClientOrderId);
  } catch (error) {
    status("SELL lookup error", error.message);
  }
  operation.sellOrder = sellOrder;
  const state = await inspectSymbol("SELL FAILURE STATE", true);
  if (!sellOrder && state.ordersKnown) {
    sellOrder =
      state.openOrders.find(
        (order) =>
          order.client_order_id === operation.sellClientOrderId,
      ) ??
      state.openOrders.find((order) => order.side === "sell") ??
      null;
    operation.sellOrder = sellOrder;
  }
  const clean =
    state.positionKnown &&
    !state.position &&
    state.ordersKnown &&
    state.openOrders.length === 0;
  if (sellOrder?.status === "filled" && clean) {
    section("SELL FAILURE RESOLVED");
    status("SELL status", "FILLED");
    status("Position", "0");
    status("Open orders", "0");
    return sellOrder;
  }
  printCriticalWarning(
    originalError,
    state,
    operation.buyOrder,
    sellOrder,
  );
  return null;
}

async function sellPositionOnce(exitReason) {
  if (operation.sellMayHaveBeenSent) {
    throw new Error("A SELL may already have been sent; no second SELL is allowed.");
  }
  await validateRegularMarket();

  operation.stage = "PREPARING SELL MARKET";
  const position = await requestSymbolPosition();
  if (!position || position.side !== "long") {
    throw new Error("No long position is available for the SELL.");
  }
  const openOrders = await requestSymbolOpenOrders();
  const openSell = openOrders.find((order) => order.side === "sell");
  if (openSell) {
    throw new Error(
      `A SELL is already open: ${openSell.client_order_id ?? openSell.id ?? "unknown"}.`,
    );
  }
  const availableQuantity = positiveNumber(
    position.qty_available,
    "Position qty_available",
  );

  const clientOrderId = createClientOrderId("sell");
  operation.stage = "SUBMITTING SELL MARKET";
  operation.currentClientOrderId = clientOrderId;
  operation.sellClientOrderId = clientOrderId;
  operation.sellMayHaveBeenSent = true;
  report.exitReason = exitReason;

  section("SELL MARKET");
  status("Exit reason", exitReason);
  status("Quantity available", availableQuantity);
  status("Client Order ID", clientOrderId);
  await submitMarketSellOrder(availableQuantity, clientOrderId);

  operation.stage = "POLLING SELL MARKET";
  try {
    const sellOrder = await pollOrder(clientOrderId, "sell");
    operation.sellOrder = sellOrder;
    if (sellOrder.status !== "filled") {
      throw new Error(
        `SELL ended with status ${sellOrder.status ?? "unknown"} | ` +
          `Filled quantity: ${sellOrder.filled_qty ?? "0"}`,
      );
    }
    return sellOrder;
  } catch (error) {
    printOriginalError(error);
    return handleSellFailure(
      error,
      error.lastOrder ?? operation.sellOrder,
    );
  }
}

function printOperationReport(finalState) {
  section("FINAL OPERATION REPORT");
  status("Mode", MODE);
  status("Symbol", SYMBOL);
  status("Opening price", report.openingPrice?.toFixed(4) ?? "-");
  status("Opening timestamp", report.openingTimestamp ?? "-");
  status("Reference price", report.referencePrice?.toFixed(4) ?? "-");
  status(
    "Initial observation duration",
    `${report.initialObservationDuration / 1000} seconds`,
  );
  status("Arm price", report.armPrice?.toFixed(4) ?? "-");
  status("BUY Stop", report.buyStopPrice ?? "-");
  status("BUY Limit", report.buyLimitPrice ?? "-");
  status("Strategy armed", report.strategyArmed ? "YES" : "NO");
  status("Armed timestamp", report.armedTimestamp ?? "-");
  status(
    "Armed during initial interval",
    report.armedDuringInitialInterval ? "YES" : "NO",
  );
  status(
    "Price at end initial interval",
    report.priceAtEndOfInitialInterval?.toFixed(4) ?? "-",
  );
  status("Entry decision", report.entryDecision ?? "-");
  status("Arm reason", report.armReason ?? "-");
  status("Final BUY status", report.buyStatus ?? "-");
  if (report.buyActiveDurationMs !== null) {
    status(
      "BUY active duration",
      `${Math.round(report.buyActiveDurationMs / 1000)} seconds`,
    );
    status(
      "Last market price",
      report.buyLastMarketPrice?.toFixed(4) ?? "-",
    );
    status(
      "Distance to stop",
      Number.isFinite(report.buyDistanceToStop)
        ? `${report.buyDistanceToStop >= 0 ? "+" : ""}${report.buyDistanceToStop.toFixed(2)}%`
        : "-",
    );
    status(
      "Last trade age",
      Number.isFinite(report.buyLastTradeAgeSeconds)
        ? `${report.buyLastTradeAgeSeconds} seconds`
        : "-",
    );
    status(
      "Cancellation",
      report.buyCancellationConfirmed ? "CONFIRMED" : "NOT CONFIRMED",
    );
  }
  status("Bought quantity", report.boughtQuantity ?? "-");
  status(
    "Real buy average",
    report.buyAveragePrice?.toFixed(4) ?? "-",
  );
  status(
    "Take profit",
    report.takeProfitPrice?.toFixed(4) ?? "-",
  );
  status("Exit reason", report.exitReason ?? "-");
  status("Sold quantity", report.soldQuantity ?? "-");
  status(
    "Real sell average",
    report.sellAveragePrice?.toFixed(4) ?? "-",
  );
  status(
    "Gross result",
    report.grossResult?.toFixed(4) ?? "-",
  );
  status("Final position", finalState.position?.qty ?? "0");
  status("Final open orders", finalState.openOrders.length);
  if (MODE === "test") {
    status(
      "Simulated signals",
      report.simulatedSignals.length
        ? report.simulatedSignals.join(" | ")
        : "NONE",
    );
    status("Official fills/results", "ALPACA PAPER ONLY");
  }
}

async function finalizeSuccessfulSell(sellOrder) {
  operation.stage = "FINAL VERIFICATION";
  const finalState = await inspectSymbol("FINAL VERIFICATION", true);
  const clean =
    finalState.positionKnown &&
    !finalState.position &&
    finalState.ordersKnown &&
    finalState.openOrders.length === 0;
  if (!clean) {
    printCriticalWarning(
      new Error("Position zero and open orders zero were not confirmed."),
      finalState,
      operation.buyOrder,
      sellOrder,
    );
    return;
  }

  report.soldQuantity = positiveNumber(
    sellOrder.filled_qty,
    "Real sold quantity",
  );
  report.sellAveragePrice = positiveNumber(
    sellOrder.filled_avg_price,
    "Real sell average price",
  );
  report.grossResult =
    report.soldQuantity * report.sellAveragePrice -
    report.boughtQuantity * report.buyAveragePrice;
  report.finalPosition = "0";
  report.finalOpenOrders = 0;
  printOperationReport(finalState);
  status("Result", "SUCCESS");
}

async function main() {
  if (!validateCommand()) {
    return;
  }

  line();
  console.log("ALPACA SINGLE-SYMBOL OPENING OPERATOR");
  line();

  operation.stage = "CONFIGURATION";
  validateConfiguration();
  loadCredentials();
  operation.credentialsLoaded = true;

  section("CONFIGURATION");
  status("Mode", MODE);
  status("Environment", "ALPACA PAPER");
  status("Symbol", SYMBOL);
  status("Quantity", QUANTITY);
  status("Data feed", DATA_FEED.toUpperCase());
  status("Market time zone", MARKET_TIME_ZONE);
  status("ARM_DROP_PERCENT", ARM_DROP_PERCENT);
  status("TAKE_PROFIT_PERCENT", TAKE_PROFIT_PERCENT);
  status("LIMIT_PERCENT_STPL", LIMIT_PERCENT_STPL);
  status(
    "Initial observation interval",
    `${INITIAL_OBSERVATION_MS / 1000} seconds`,
  );
  status(
    "Strategy total duration",
    `${STRATEGY_TOTAL_DURATION_MINUTES} minutes`,
  );
  status("BUY active timeout", `${BUY_ACTIVE_TIMEOUT_MINUTES} minutes`);
  status("Position timeout", `${POSITION_TIMEOUT_MS / 1000} seconds`);
  status("Test exit mode", TEST_EXIT_MODE);

  const initial = await initialValidation();
  const signalState =
    MODE === "opening"
      ? await prepareOpeningSignals(initial.sessionDate)
      : await prepareTestSignals(initial.sessionDate);

  if (!signalState) {
    await finishWithoutPosition(
      "NO ENTRY",
      MODE === "opening"
        ? "No valid regular trade was available from 09:30 ET during the 1-minute capture window."
        : "Required opening/reference price was not available.",
    );
    return;
  }

  const setup = calculateStrategyPrices(signalState.referencePrice);
  report.openingPrice = signalState.openingPrice;
  report.openingTimestamp = signalState.openingTimestamp;
  report.referencePrice = setup.referencePrice;
  report.armPrice = setup.armPrice;
  report.buyStopPrice = setup.buyStopPrice.text;
  report.buyLimitPrice = setup.buyLimitPrice.text;
  const entryDeadlineMs =
    signalState.entryWindowStartedAtMs + ENTRY_WINDOW_MS;
  printStrategySetup(setup, signalState, entryDeadlineMs);

  const entryDecision = await determineEntryDecision(
    setup,
    signalState,
    entryDeadlineMs,
  );
  if (!entryDecision.sendOrder) {
    await finishWithoutPosition(
      "NO ENTRY",
      entryDecision.reason,
    );
    return;
  }

  const estimatedBuyCost = setup.buyLimitPrice.number * QUANTITY;
  if (Number(initial.account.buying_power) < estimatedBuyCost) {
    throw new Error(
      `Insufficient buying power: ${initial.account.buying_power} < ` +
        `${estimatedBuyCost.toFixed(2)}.`,
    );
  }

  const buy = await executeBuy(setup, signalState);
  if (buy.result === "NO BUY FILL") {
    await finishWithoutPosition(
      buy.buyTimedOut ? "BUY TIMEOUT — NO FILL" : "NO BUY FILL",
      buy.buyTimedOut
        ? "BUY active period ended without a fill; cancellation and clean final state were confirmed."
        : "BUY STOP-LIMIT ended without a position.",
    );
    return;
  }
  if (buy.result !== "POSITION") {
    return;
  }

  operation.buyOrder = buy.buyOrder;
  const buyDetails = officialBuyDetails(buy.buyOrder, buy.position);
  section("REAL POSITION CONFIRMED");
  status("BUY status", report.buyStatus);
  status("Bought quantity", buyDetails.quantity);
  status("Real buy average", buyDetails.averagePrice.toFixed(4));
  status("Quantity available", buy.position.qty_available);
  status("Take profit", report.takeProfitPrice.toFixed(4));

  const exitReason = await determineExitReason(buyDetails, signalState);
  const sellOrder = await sellPositionOnce(exitReason);
  if (!sellOrder) {
    return;
  }
  await finalizeSuccessfulSell(sellOrder);
}

main().catch(async (error) => {
  printOriginalError(error);

  if (operation.sellMayHaveBeenSent) {
    try {
      const resolvedSell = await handleSellFailure(
        error,
        operation.sellOrder,
      );
      if (resolvedSell) {
        await finalizeSuccessfulSell(resolvedSell);
        process.exitCode = 1;
      }
    } catch (inspectionError) {
      const unknownState = {
        position: null,
        openOrders: [],
        positionKnown: false,
        ordersKnown: false,
      };
      printCriticalWarning(
        new Error(`${error.message} | ${inspectionError.message}`),
        unknownState,
        operation.buyOrder,
        operation.sellOrder,
      );
    }
    return;
  }

  if (operation.buyMayHaveBeenSent) {
    try {
      const resolution = await resolveBuyFailure(
        error,
        operation.buyOrder,
      );
      operation.buyOrder = resolution.buyOrder;
      if (resolution.result === "NO BUY FILL") {
        await finishWithoutPosition(
          "NO BUY FILL",
          "Failure resolved without a position or open order.",
        );
        process.exitCode = 1;
        return;
      }
      if (resolution.result === "POSITION") {
        const buyDetails = officialBuyDetails(
          resolution.buyOrder,
          resolution.position,
        );
        const sellOrder = await sellPositionOnce("ERROR RECOVERY");
        if (sellOrder) {
          await finalizeSuccessfulSell(sellOrder);
        }
        process.exitCode = 1;
        return;
      }
    } catch (cleanupError) {
      const state = await inspectSymbol("FAILURE CLEANUP STATE", true);
      printCriticalWarning(
        new Error(`${error.message} | Cleanup: ${cleanupError.message}`),
        state,
        operation.buyOrder,
        operation.sellOrder,
      );
    }
    return;
  }

  if (operation.credentialsLoaded) {
    const state = await inspectSymbol("FINAL STATE AFTER ERROR", true);
    const clean =
      state.positionKnown &&
      !state.position &&
      state.ordersKnown &&
      state.openOrders.length === 0;
    if (!clean) {
      printCriticalWarning(error, state, null, null);
      return;
    }
    status("Final state", "POSITION 0 / OPEN ORDERS 0");
  }
  process.exitCode = 1;
});
