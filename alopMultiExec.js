const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");

const ENV_FILE = ".env.local";
const STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";
const TRADING_STREAM_URL = "wss://paper-api.alpaca.markets/stream";
const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
const QUANTITY = 10;
const BUY_LIMIT_PERCENT = 0.01;
const HTTP_TIMEOUT_MS = 10 * 1000;
const TEST_SESSION_DURATION_MS = 60 * 1000;
const REGULAR_OPEN_HOUR = 9;
const REGULAR_OPEN_MINUTE = 30;
const OPENING_SESSION_END_HOUR = 9;
const OPENING_SESSION_END_MINUTE = 40;
const PANEL_INTERVAL_MS = 500;
const STEP_TIMEOUT_MS = 10 * 1000;
const CLOSE_TIMEOUT_MS = 5 * 1000;
const MAX_RECENT_EVENTS = 6;
const OPENING_MODE = "OPENING"; // "TEST" or "OPENING"
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
      "Usage: node alopMultiExec.js NVDA [TSLA AMD MSFT AAPL]",
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

function validateOpeningMode() {
  if (!["TEST", "OPENING"].includes(OPENING_MODE)) {
    throw createFailure(
      "CONFIGURATION",
      `Invalid OPENING_MODE: ${OPENING_MODE}. Expected TEST or OPENING.`,
    );
  }
}

function validateExecutionConfiguration() {
  validateOpeningMode();
  if (typeof globalThis.fetch !== "function") {
    throw createFailure("CONFIGURATION", "Native fetch is unavailable.");
  }
  if (
    ALPACA_PAPER_URL !== "https://paper-api.alpaca.markets" ||
    TRADING_STREAM_URL !== "wss://paper-api.alpaca.markets/stream"
  ) {
    throw createFailure(
      "CONFIGURATION",
      "Execution must use Alpaca Paper Trading.",
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

async function requestAlpaca(
  url,
  options = {},
  fetchImpl = globalThis.fetch,
) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
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
        throw createFailure(
          "REST",
          `Alpaca returned invalid JSON: ${error.message}`,
        );
      }
    }
    if (!response.ok) {
      throw createFailure(
        "REST",
        `Alpaca HTTP ${response.status}: ${payload?.message ?? "unknown error"}`,
        { httpStatus: response.status },
      );
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw createFailure(
        "REST",
        `Alpaca request timed out after ${timeoutMs} ms.`,
        { code: "ALPACA_TIMEOUT" },
      );
    }
    if (error instanceof TypeError) {
      throw createFailure("REST", `Alpaca network error: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw createFailure("VALIDATION", `${label} must be a positive number.`);
  }
  return number;
}

function roundPrice(price, direction) {
  const decimals = price >= 1 ? 2 : 4;
  const factor = 10 ** decimals;
  let rounded;
  if (direction === "up") {
    rounded = Math.ceil(price * factor - 1e-9) / factor;
  } else {
    rounded = Math.round(price * factor) / factor;
  }
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw createFailure("VALIDATION", "Calculated BUY price is invalid.");
  }
  return { number: rounded, text: rounded.toFixed(decimals) };
}

function calculateBuyPrices(openingPrice) {
  const stop = roundPrice(openingPrice, "nearest");
  let limit = roundPrice(openingPrice * (1 + BUY_LIMIT_PERCENT), "up");
  if (limit.number < stop.number) {
    limit = { number: stop.number, text: stop.text };
  }
  return { stop, limit };
}

let clientOrderSequence = 0;

function createBuyClientOrderId(symbol, now = new Date()) {
  clientOrderSequence = (clientOrderSequence + 1) % 100;
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 17);
  return (
    `ALOP-${OPENING_MODE}-BUY-${symbol}-${stamp}-` +
    String(clientOrderSequence).padStart(2, "0")
  );
}

function submitStopLimitBuyOrder(
  symbol,
  stopPrice,
  limitPrice,
  clientOrderId,
  fetchImpl = globalThis.fetch,
) {
  return requestAlpaca(
    `${ALPACA_PAPER_URL}/v2/orders`,
    {
      method: "POST",
      body: {
        symbol,
        qty: String(QUANTITY),
        side: "buy",
        type: "stop_limit",
        time_in_force: "day",
        stop_price: stopPrice,
        limit_price: limitPrice,
        extended_hours: false,
        client_order_id: clientOrderId,
      },
    },
    fetchImpl,
  );
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

async function validateExecutionPreflight(
  symbols,
  fetchImpl = globalThis.fetch,
) {
  const symbolsQuery = encodeURIComponent(symbols.join(","));
  const [account, positions, openOrders, ...assets] = await Promise.all([
    requestAlpaca(`${ALPACA_PAPER_URL}/v2/account`, {}, fetchImpl),
    requestAlpaca(`${ALPACA_PAPER_URL}/v2/positions`, {}, fetchImpl),
    requestAlpaca(
      `${ALPACA_PAPER_URL}/v2/orders?status=open&symbols=${symbolsQuery}` +
        "&direction=desc&nested=true&limit=50",
      {},
      fetchImpl,
    ),
    ...symbols.map((symbol) =>
      requestAlpaca(
        `${ALPACA_PAPER_URL}/v2/assets/${encodeURIComponent(symbol)}`,
        {},
        fetchImpl,
      ),
    ),
  ]);

  if (
    account?.status !== "ACTIVE" ||
    account.trading_blocked !== false ||
    account.account_blocked === true
  ) {
    throw createFailure(
      "PREFLIGHT",
      "Paper account is not active and enabled for trading.",
    );
  }
  positiveNumber(account.buying_power, "Account buying power");
  if (!Array.isArray(positions) || !Array.isArray(openOrders)) {
    throw createFailure(
      "PREFLIGHT",
      "Alpaca returned invalid positions or open orders.",
    );
  }

  const symbolSet = new Set(symbols);
  const existingPosition = positions.find((position) =>
    symbolSet.has(position.symbol?.toUpperCase()),
  );
  if (existingPosition) {
    throw createFailure(
      "PREFLIGHT",
      `${existingPosition.symbol} must start with position zero.`,
    );
  }
  const existingOrder = openOrders.find((order) =>
    symbolSet.has(order.symbol?.toUpperCase()),
  );
  if (existingOrder) {
    throw createFailure(
      "PREFLIGHT",
      `${existingOrder.symbol} must start with open orders zero.`,
    );
  }

  for (let index = 0; index < symbols.length; index += 1) {
    const asset = assets[index];
    if (
      asset?.symbol?.toUpperCase() !== symbols[index] ||
      asset.status !== "active" ||
      asset.tradable !== true
    ) {
      throw createFailure(
        "PREFLIGHT",
        `${symbols[index]} is not an active tradable asset.`,
      );
    }
  }
}

async function validateRegularMarket(fetchImpl = globalThis.fetch) {
  const clock = await requestAlpaca(
    `${ALPACA_PAPER_URL}/v2/clock`,
    {},
    fetchImpl,
  );
  if (clock?.is_open !== true || !isRegularSessionTrade(Date.now())) {
    throw createFailure(
      "BUY VALIDATION",
      "Regular market must be open between 09:30 and 16:00 ET.",
    );
  }
  return clock;
}

function acceptsOpeningTrade(
  openingCanBeDetermined,
  operationalSessionStarted,
  timestampMs,
  openingMode = OPENING_MODE,
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

function createExecutionLayer({
  fetchImpl = globalThis.fetch,
  validateMarketImpl = () => validateRegularMarket(fetchImpl),
  now = () => new Date(),
} = {}) {
  const ordersByClientId = new Map();
  const pendingSubmissions = new Set();

  function eventTimestamp(data) {
    return (
      data?.timestamp ??
      data?.order?.updated_at ??
      data?.order?.submitted_at ??
      now().toISOString()
    );
  }

  function updateFillDetails(state, order) {
    const filledQuantity = Number(order?.filled_qty ?? 0);
    if (
      Number.isFinite(filledQuantity) &&
      filledQuantity >= state.filledQuantity
    ) {
      state.filledQuantity = filledQuantity;
    }
    const averageFillPrice = Number(order?.filled_avg_price);
    if (Number.isFinite(averageFillPrice) && averageFillPrice > 0) {
      state.averageFillPrice = averageFillPrice;
    }
  }

  function markAccepted(entry, timestamp) {
    const { state, recordEvent } = entry;
    if (
      state.buyAcceptedAt !== null ||
      ["BUY_REJECTED", "BUY_CANCELED"].includes(state.state)
    ) {
      return;
    }
    state.buyAcceptedAt = timestamp;
    if (["BUY_SUBMITTING", "BUY_SUBMITTED"].includes(state.state)) {
      state.state = "BUY_SUBMITTED";
    }
    recordEvent(
      `${state.symbol} BUY ACCEPTED | client_order_id ${state.clientOrderId}`,
    );
  }

  function handleTradeUpdate(data) {
    if (!data || typeof data !== "object" || !data.order) {
      throw createFailure(
        "TRADING UPDATES",
        "Alpaca returned an invalid trade update.",
      );
    }
    const event = String(data.event ?? "").toLowerCase();
    const order = data.order;
    const clientOrderId = order.client_order_id;
    const entry = ordersByClientId.get(clientOrderId);
    if (!entry) {
      return;
    }

    const { state, recordEvent } = entry;
    if (
      order.symbol?.toUpperCase() !== state.symbol ||
      order.side?.toLowerCase() !== "buy"
    ) {
      return;
    }
    state.buyOrderId ??= order.id ?? null;
    const timestamp = eventTimestamp(data);

    if (["accepted", "pending_new", "new"].includes(event)) {
      markAccepted(entry, timestamp);
      return;
    }

    if (event === "partial_fill") {
      markAccepted(entry, order.submitted_at ?? timestamp);
      const previousFilledQuantity = state.filledQuantity;
      updateFillDetails(state, order);
      if (
        !["BUY_FILLED", "BUY_REJECTED", "BUY_CANCELED"].includes(
          state.state,
        )
      ) {
        state.state = "BUY_PARTIALLY_FILLED";
      }
      if (state.filledQuantity > previousFilledQuantity) {
        recordEvent(
          `${state.symbol} BUY PARTIAL FILL | filled ${state.filledQuantity} | ` +
            `average ${state.averageFillPrice?.toFixed(4) ?? "-"}`,
        );
      }
      return;
    }

    if (event === "fill") {
      markAccepted(entry, order.submitted_at ?? timestamp);
      updateFillDetails(state, order);
      if (state.buyFilledAt === null) {
        state.state = "BUY_FILLED";
        state.buyFilledAt = order.filled_at ?? timestamp;
        recordEvent(
          `${state.symbol} BUY FILLED | filled ${state.filledQuantity} | ` +
            `average ${state.averageFillPrice?.toFixed(4) ?? "-"}`,
        );
      }
      return;
    }

    if (event === "rejected") {
      if (
        state.buyRejectedAt === null &&
        !["BUY_FILLED", "BUY_CANCELED"].includes(state.state)
      ) {
        state.state = "BUY_REJECTED";
        state.buyRejectedAt = order.failed_at ?? timestamp;
        recordEvent(
          `${state.symbol} BUY REJECTED | ` +
            `${order.reject_reason ?? order.reason ?? "no reason"}`,
        );
      }
      return;
    }

    if (event === "canceled") {
      updateFillDetails(state, order);
      if (
        state.buyCanceledAt === null &&
        !["BUY_FILLED", "BUY_REJECTED"].includes(state.state)
      ) {
        state.state = "BUY_CANCELED";
        state.buyCanceledAt = order.canceled_at ?? timestamp;
        recordEvent(
          `${state.symbol} BUY CANCELED | filled ${state.filledQuantity}`,
        );
      }
    }
  }

  async function submitBuyInternal(state, recordEvent) {
    if (state.buySubmissionStarted) {
      return;
    }
    state.buySubmissionStarted = true;
    state.state = "BUY_SUBMITTING";
    state.buySubmissionAttemptedAt = now().toISOString();
    state.clientOrderId = createBuyClientOrderId(state.symbol, now());
    const entry = { state, recordEvent };
    ordersByClientId.set(state.clientOrderId, entry);
    recordEvent(
      `${state.symbol} BUY SUBMISSION ATTEMPT | ` +
        `client_order_id ${state.clientOrderId}`,
    );

    try {
      await validateMarketImpl();
      const prices = calculateBuyPrices(state.openingPrice);
      state.buyPostSentAt = now().toISOString();
      recordEvent(
        `${state.symbol} BUY POST SENT | client_order_id ${state.clientOrderId}`,
      );
      const order = await submitStopLimitBuyOrder(
        state.symbol,
        prices.stop.text,
        prices.limit.text,
        state.clientOrderId,
        fetchImpl,
      );
      if (
        !order ||
        order.client_order_id !== state.clientOrderId ||
        order.symbol?.toUpperCase() !== state.symbol ||
        order.side?.toLowerCase() !== "buy"
      ) {
        throw createFailure(
          "BUY SUBMISSION",
          "Alpaca returned a different BUY order.",
        );
      }

      state.buyOrderId = order.id ?? state.buyOrderId;
      state.buySubmittedAt = now().toISOString();
      recordEvent(
        `${state.symbol} BUY SUBMITTED | order_id ${state.buyOrderId ?? "-"}`,
      );
      if (state.state === "BUY_SUBMITTING") {
        state.state = "BUY_SUBMITTED";
      }
      const status = order.status?.toLowerCase();
      if (["accepted", "pending_new", "new"].includes(status)) {
        markAccepted(entry, order.submitted_at ?? now().toISOString());
      } else if (["partially_filled", "filled", "rejected", "canceled"].includes(status)) {
        handleTradeUpdate({
          event:
            status === "partially_filled"
              ? "partial_fill"
              : status === "canceled"
                ? "canceled"
                : status,
          order,
          timestamp: order.updated_at,
        });
      }
    } catch (error) {
      if (
        state.buySubmittedAt === null &&
        state.buyAcceptedAt === null &&
        !["BUY_FILLED", "BUY_REJECTED", "BUY_CANCELED"].includes(state.state)
      ) {
        state.state = "BUY_SUBMISSION_FAILED";
        state.buySubmissionFailedAt = now().toISOString();
        recordEvent(
          `${state.symbol} BUY SUBMISSION FAILED | ${error.message}`,
        );
      }
    }
  }

  function submitBuy(state, recordEvent) {
    if (state.buySubmissionStarted) {
      return Promise.resolve();
    }
    const submission = submitBuyInternal(state, recordEvent);
    pendingSubmissions.add(submission);
    submission.finally(() => pendingSubmissions.delete(submission));
    return submission;
  }

  async function waitForSubmissions() {
    await Promise.allSettled([...pendingSubmissions]);
  }

  return {
    handleTradeUpdate,
    submitBuy,
    waitForSubmissions,
  };
}

async function decodeTradingMessageData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  if (typeof data?.text === "function") {
    return data.text();
  }
  throw createFailure(
    "TRADING UPDATES",
    "Received an unsupported Trading Updates frame.",
  );
}

function connectTradingUpdates({
  onTradeUpdate,
  WebSocketImpl = globalThis.WebSocket,
  stepTimeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== "function") {
      reject(
        createFailure("CONFIGURATION", "Native WebSocket is unavailable."),
      );
      return;
    }

    let socket;
    let stage = "TRADING CONNECTING";
    let timer;
    let ready = false;
    let failed = false;
    let localCloseRequested = false;
    let closeResolve;
    let rejectFailure;
    const failurePromise = new Promise((unusedResolve, failureReject) => {
      rejectFailure = failureReject;
    });
    failurePromise.catch(() => {});

    function clearTimer() {
      clearTimeout(timer);
      timer = undefined;
    }

    function waitForStep() {
      clearTimer();
      timer = setTimeout(() => {
        fail(
          createFailure(stage, `Timed out after ${stepTimeoutMs} ms.`),
        );
      }, stepTimeoutMs);
    }

    function fail(error) {
      if (failed) {
        return;
      }
      failed = true;
      clearTimer();
      const failure = error?.stage
        ? error
        : createFailure(stage, error?.message ?? "Trading Updates failure.");
      if (ready) {
        rejectFailure(failure);
      } else {
        reject(failure);
      }
      if (socket?.readyState === WebSocketImpl.OPEN) {
        socket.close(1000, "trading updates failure");
      }
    }

    function close() {
      if (
        !socket ||
        socket.readyState === WebSocketImpl.CLOSED ||
        socket.readyState === 3
      ) {
        return Promise.resolve();
      }
      localCloseRequested = true;
      clearTimer();
      return new Promise((closeDone) => {
        closeResolve = closeDone;
        socket.close(1000, "session complete");
        timer = setTimeout(closeDone, CLOSE_TIMEOUT_MS);
      });
    }

    try {
      socket = new WebSocketImpl(TRADING_STREAM_URL);
    } catch (error) {
      reject(
        createFailure(
          stage,
          `Could not create Trading Updates WebSocket: ${error.message}`,
        ),
      );
      return;
    }
    waitForStep();

    socket.addEventListener("open", () => {
      stage = "TRADING AUTHENTICATING";
      socket.send(
        JSON.stringify({
          action: "auth",
          key: process.env.ALPACA_API_KEY_ID,
          secret: process.env.ALPACA_API_SECRET_KEY,
        }),
      );
      waitForStep();
    });

    socket.addEventListener("message", async (event) => {
      try {
        const content = await decodeTradingMessageData(event.data);
        const message = JSON.parse(content);
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw createFailure(
            stage,
            "Alpaca returned an invalid Trading Updates message.",
          );
        }

        if (
          message.stream === "authorization" &&
          message.data?.status === "authorized"
        ) {
          stage = "TRADING SUBSCRIBING";
          socket.send(
            JSON.stringify({
              action: "listen",
              data: { streams: ["trade_updates"] },
            }),
          );
          waitForStep();
          return;
        }
        if (
          message.stream === "authorization" &&
          message.data?.status === "unauthorized"
        ) {
          throw createFailure(
            stage,
            "Trading Updates authentication was rejected.",
          );
        }
        if (message.stream === "listening") {
          const streams = Array.isArray(message.data?.streams)
            ? message.data.streams
            : [];
          if (!streams.includes("trade_updates")) {
            throw createFailure(
              stage,
              "trade_updates subscription was not confirmed.",
            );
          }
          clearTimer();
          stage = "TRADING UPDATES READY";
          ready = true;
          resolve({ close, failurePromise });
          return;
        }
        if (message.stream === "trade_updates" && ready) {
          await onTradeUpdate(message.data);
          return;
        }
        throw createFailure(
          stage,
          `Unexpected Trading Updates message: ${content}`,
        );
      } catch (error) {
        fail(error);
      }
    });

    socket.addEventListener("error", () => {
      fail(
        createFailure(stage, "Trading Updates WebSocket emitted an error."),
      );
    });

    socket.addEventListener("close", (event) => {
      clearTimer();
      if (localCloseRequested) {
        closeResolve?.();
        return;
      }
      fail(
        createFailure(
          stage,
          "Trading Updates WebSocket closed unexpectedly.",
          { closeCode: event.code, closeReason: event.reason },
        ),
      );
    });
  });
}

function runMarketDataSession(
  symbols,
  logs,
  processStartedAt,
  {
    WebSocketImpl = globalThis.WebSocket,
    openingMode = OPENING_MODE,
    testSessionDurationMs = TEST_SESSION_DURATION_MS,
    renderOutput = true,
    onTriggered = null,
    externalFailurePromise = null,
  } = {},
) {
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
          buySubmissionStarted: false,
          buyOrderId: null,
          clientOrderId: null,
          buySubmissionAttemptedAt: null,
          buyPostSentAt: null,
          buySubmittedAt: null,
          buyAcceptedAt: null,
          buySubmissionFailedAt: null,
          buyFilledAt: null,
          buyRejectedAt: null,
          buyCanceledAt: null,
          filledQuantity: 0,
          averageFillPrice: null,
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
      const lines = [
        "ALOP MULTI EXEC — ALPACA IEX + PAPER",
        `OPENING MODE | ${openingMode}`,
        `STATUS | ${stage} | ${elapsed.toFixed(1)}/${formatDuration(operationalSessionDurationMs)} | ` +
          `Symbols ${symbols.length} | Trades ${totalTrades}`,
        "",
        [
          "SYMBOL".padEnd(6),
          "QTY".padStart(3),
          "LAST".padStart(10),
          "OPEN".padStart(10),
          "LOW".padStart(10),
          "DD%".padStart(7),
          "STATE".padEnd(21),
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
            state.state.padEnd(21),
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
      clearTimers();
      stopPanel();
      if (error) {
        error.partialResult = {
          states,
          totalTrades,
          durationSeconds: elapsedSeconds(),
          operationalSessionDurationMs,
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

    if (externalFailurePromise) {
      externalFailurePromise.catch((error) => {
        fail(
          error?.stage
            ? error
            : createFailure(
                "TRADING UPDATES",
                error?.message ?? "Trading Updates failed.",
              ),
        );
      });
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
          openingMode === "TEST" || isBeforeRegularOpen(processStartedAt);
        panelTimer = setInterval(renderPanel, PANEL_INTERVAL_MS);

        if (openingMode === "TEST") {
          const startedAt = Date.now();
          startOperationalSession(
            startedAt,
            startedAt + testSessionDurationMs,
          );
          return;
        }

        if (!openingCanBeDetermined) {
          showEvent(
            "OPENING unavailable: process started at or after 09:30 ET; " +
              "symbols will remain in WAITING_OPEN",
          );
          const startedAt = Date.now();
          startOperationalSession(
            startedAt,
            startedAt + testSessionDurationMs,
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
            `${state.symbol} | OPENING PRICE | MODE ${openingMode} | ` +
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
          if (typeof onTriggered === "function") {
            void onTriggered(state, recordMarketEvent);
          }
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

function findUnresolvedExecutionStates(result) {
  const activeStates = new Set([
    "BUY_SUBMITTING",
    "BUY_SUBMITTED",
    "BUY_PARTIALLY_FILLED",
    "BUY_FILLED",
  ]);
  const unresolved = [];

  for (const state of result.states.values()) {
    let reason = null;
    if (activeStates.has(state.state)) {
      reason = state.state;
    } else if (state.state === "BUY_CANCELED" && state.filledQuantity > 0) {
      reason = `BUY_CANCELED with residual quantity ${state.filledQuantity}`;
    } else if (
      state.state === "BUY_SUBMISSION_FAILED" &&
      state.buyPostSentAt !== null
    ) {
      reason = "BUY_SUBMISSION_FAILED after POST was sent";
    }
    if (reason !== null) {
      unresolved.push({ symbol: state.symbol, reason });
    }
  }
  return unresolved;
}

function summaryTimestamp(timestamp) {
  return timestamp === null ? "NO" : `YES @ ${compactMarketTimestamp(timestamp)}`;
}

function printSummary(result, logs) {
  console.log();
  console.log("SESSION SUMMARY");
  console.log(`Opening mode: ${OPENING_MODE}`);
  console.log(
    `Configured operational duration: ${formatDuration(result.operationalSessionDurationMs)}`,
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
      `${state.symbol}: ${state.tradeCount} trades | Opening ${opening} | ` +
        `Low ${low} | DD ${drawdown} | State ${state.state} | ` +
        `Armed ${armed} | Trigger ${triggered} | ` +
        `BUY attempt ${summaryTimestamp(state.buySubmissionAttemptedAt)} | ` +
        `POST sent ${summaryTimestamp(state.buyPostSentAt)} | ` +
        `BUY submitted ${summaryTimestamp(state.buySubmittedAt)} | ` +
        `BUY accepted ${summaryTimestamp(state.buyAcceptedAt)} | ` +
        `BUY submission failed ${summaryTimestamp(state.buySubmissionFailedAt)} | ` +
        `Filled ${state.filledQuantity} @ ` +
        `${state.averageFillPrice?.toFixed(4) ?? "-"} | ` +
        `BUY rejected ${summaryTimestamp(state.buyRejectedAt)} | ` +
        `BUY canceled ${summaryTimestamp(state.buyCanceledAt)}`,
    );
  }
  console.log(`Total trades: ${result.totalTrades}`);
  console.log(
    `Actual operational duration: ${result.durationSeconds.toFixed(3)} seconds`,
  );
  console.log(`events.log: ${logs.eventsPath}`);
  console.log(`prices.csv: ${logs.pricesPath}`);
}

async function main() {
  const processStartedAt = Date.now();
  validateExecutionConfiguration();
  const symbols = readSymbols();
  loadCredentials();
  const logs = await createRunLogs();
  let tradingUpdates = null;

  try {
    await validateExecutionPreflight(symbols);
    const execution = createExecutionLayer();
    tradingUpdates = await connectTradingUpdates({
      onTradeUpdate: execution.handleTradeUpdate,
    });
    const result = await runMarketDataSession(
      symbols,
      logs,
      processStartedAt,
      {
        onTriggered: execution.submitBuy,
        externalFailurePromise: tradingUpdates.failurePromise,
      },
    );
    await execution.waitForSubmissions();
    await tradingUpdates.close();
    printSummary(result, logs);
    const unresolved = findUnresolvedExecutionStates(result);
    if (unresolved.length > 0) {
      console.error("Stage: UNRESOLVED EXECUTION STATE");
      for (const item of unresolved) {
        console.error(`${item.symbol}: ${item.reason}`);
      }
      console.error("Result: FAILURE");
      process.exitCode = 1;
    } else {
      console.log("Result: SUCCESS");
    }
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
    await tradingUpdates?.close();
    await closeRunLogs(logs);
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
  calculateBuyPrices,
  connectTradingUpdates,
  createBuyClientOrderId,
  createExecutionLayer,
  findUnresolvedExecutionStates,
  runMarketDataSession,
  validateExecutionPreflight,
};
