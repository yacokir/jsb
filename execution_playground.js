const VERBOSE = false;
const DEFAULT_SYMBOL = "NVDA";
const SYMBOL = (process.argv[2]?.trim() || DEFAULT_SYMBOL).toUpperCase();
const POLLING_INTERVAL_MS = 2 * 1000;
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
const PRE_REFERENCE_TIMEOUT_MS = 60 * 1000;
const STRATEGY_TIMEOUT_MS = 5 * 60 * 1000;
const POSITION_TIMEOUT_MS = 60 * 1000; // Tempo maximo para a posicao simulada permanecer aberta antes de fechar por timeout.
const SIMULATED_OPEN_DELAY_MS = 5 * 1000;

const ARM_DROP_PERCENT = 0.02; // Queda necessária para armar a estratégia.
const TAKE_PROFIT_PERCENT = 0.025; // Alvo após a entrada.
const LIMIT_PERCENT_STPL = 0.001; // Margem acima do Stop para o Limit da Buy Stop-Limit.

/*
const ARM_DROP_PERCENT = 0.0003; // Queda necessária para armar a estratégia.
const TAKE_PROFIT_PERCENT = 0.0005; // Alvo após a entrada.
const LIMIT_PERCENT_STPL = 0.0001; // Margem acima do Stop para o Limit da Buy Stop-Limit.
*/

const SIMULATED_QUANTITY = 100;
const REQUEST_TIMEOUT_MS = 10 * 1000;

const YAHOO_ENDPOINT_NAME = "CHART v8 / includePrePost";
const YAHOO_ENDPOINT =
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}` +
  "?interval=1m&range=1d&includePrePost=true";

const STATES = Object.freeze({
  STARTING: "STARTING",
  WAITING_REFERENCE: "WAITING_REFERENCE",
  WAITING_TRIGGER: "WAITING_TRIGGER",
  WAITING_STOP_ACTIVATION: "WAITING_STOP_ACTIVATION",
  WAITING_LIMIT_FILL: "WAITING_LIMIT_FILL",
  POSITION_OPEN: "SIMULATED_POSITION_OPEN",
  POSITION_CLOSED_TP: "SIMULATED_POSITION_CLOSED_TP",
  POSITION_CLOSED_TIMEOUT: "SIMULATED_POSITION_CLOSED_TIMEOUT",
  FINISHED_NO_ENTRY: "FINISHED_NO_ENTRY",
  PRE_REFERENCE_TIMEOUT: "PRE_REFERENCE_TIMEOUT",
  INTERRUPTED: "INTERRUPTED",
  ERROR: "ERROR",
});

function line(character = "=") {
  console.log(character.repeat(56));
}

function status(label, value) {
  console.log(`${label.padEnd(25, ".")} ${value}`);
}

function verbose(message) {
  if (VERBOSE) {
    console.log(`[VERBOSE] ${message}`);
  }
}

function transitionTo(state, nextState, reason) {
  if (state.currentState === nextState) {
    return;
  }
  const previousState = state.currentState;
  state.currentState = nextState;
  state.transitions.push(nextState);
  verbose(
    `State transition: ${previousState} -> ${nextState}${reason ? ` (${reason})` : ""}`,
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateConfiguration() {
  if (typeof fetch !== "function") {
    throw new Error("Native fetch is unavailable.");
  }

  const positiveParameters = {
    POLLING_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS,
    PRE_REFERENCE_TIMEOUT_MS,
    STRATEGY_TIMEOUT_MS,
    POSITION_TIMEOUT_MS,
    SIMULATED_OPEN_DELAY_MS,
    ARM_DROP_PERCENT,
    TAKE_PROFIT_PERCENT,
    SIMULATED_QUANTITY,
    REQUEST_TIMEOUT_MS,
  };

  for (const [name, value] of Object.entries(positiveParameters)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid configuration: ${name} must be positive.`);
    }
  }

  if (ARM_DROP_PERCENT >= 1 || TAKE_PROFIT_PERCENT >= 1) {
    throw new Error("Percentage parameters must be decimal fractions below 1.");
  }
}

function deriveMarketState(meta, timestampSeconds) {
  const periods = meta?.currentTradingPeriod;
  if (!Number.isFinite(timestampSeconds) || !periods) {
    return "UNKNOWN";
  }
  if (timestampSeconds >= periods.pre?.start && timestampSeconds < periods.pre?.end) {
    return "PRE";
  }
  if (
    timestampSeconds >= periods.regular?.start &&
    timestampSeconds < periods.regular?.end
  ) {
    return "REGULAR";
  }
  if (timestampSeconds >= periods.post?.start && timestampSeconds < periods.post?.end) {
    return "POST";
  }
  return "UNKNOWN";
}

function latestChartPoint(chart) {
  const timestamps = chart?.timestamp;
  const closes = chart?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
    return null;
  }

  for (let index = Math.min(timestamps.length, closes.length) - 1; index >= 0; index -= 1) {
    if (Number.isFinite(Number(timestamps[index])) && isPositiveNumber(closes[index])) {
      return {
        timestampSeconds: Number(timestamps[index]),
        price: Number(closes[index]),
      };
    }
  }
  return null;
}

function selectYahooPrice(chart, receivedAtMs) {
  const meta = chart?.meta;
  const chartPoint = latestChartPoint(chart);
  const stateTimestamp = chartPoint?.timestampSeconds ?? Number(meta?.regularMarketTime);
  const marketState =
    typeof meta?.marketState === "string"
      ? meta.marketState
      : deriveMarketState(meta, stateTimestamp);
  let price = null;
  let selectedField = null;
  let yahooTimestampSeconds = null;

  if (["PRE", "PREPRE"].includes(marketState) && isPositiveNumber(meta?.preMarketPrice)) {
    price = Number(meta.preMarketPrice);
    selectedField = "preMarketPrice";
    yahooTimestampSeconds = Number(meta.preMarketTime);
  } else if (marketState === "REGULAR" && isPositiveNumber(meta?.regularMarketPrice)) {
    price = Number(meta.regularMarketPrice);
    selectedField = "regularMarketPrice";
    yahooTimestampSeconds = Number(meta.regularMarketTime);
  } else if (
    ["POST", "POSTPOST"].includes(marketState) &&
    isPositiveNumber(meta?.postMarketPrice)
  ) {
    price = Number(meta.postMarketPrice);
    selectedField = "postMarketPrice";
    yahooTimestampSeconds = Number(meta.postMarketTime);
  } else if (chartPoint) {
    price = chartPoint.price;
    selectedField = "chart.indicators.quote.close";
    yahooTimestampSeconds = chartPoint.timestampSeconds;
  } else if (isPositiveNumber(meta?.regularMarketPrice)) {
    price = Number(meta.regularMarketPrice);
    selectedField = "regularMarketPrice";
    yahooTimestampSeconds = Number(meta.regularMarketTime);
  }

  if (!isPositiveNumber(price)) {
    return null;
  }

  const hasYahooTimestamp =
    Number.isFinite(yahooTimestampSeconds) && yahooTimestampSeconds > 0;
  const timestampMs = hasYahooTimestamp ? yahooTimestampSeconds * 1000 : receivedAtMs;

  return {
    price,
    marketState,
    selectedField,
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    receivedAtMs,
    receivedAt: new Date(receivedAtMs).toISOString(),
    timestampBasis: hasYahooTimestamp ? "YAHOO" : "LOCAL RECEIPT TIME",
  };
}

async function requestYahoo(state, showAudit = false) {
  state.metrics.requestsAttempted += 1;
  verbose(`Yahoo request #${state.metrics.requestsAttempted} started.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(YAHOO_ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";

    if (showAudit) {
      status("Yahoo endpoint", YAHOO_ENDPOINT_NAME);
      status("HTTP status", response.status);
      status("Content-Type", contentType || "missing");
    }

    if ([401, 403, 429].includes(response.status)) {
      state.metrics.httpErrors += 1;
      throw new Error(`Yahoo access blocked with HTTP ${response.status}; no bypass attempted.`);
    }
    if (!response.ok) {
      state.metrics.httpErrors += 1;
      console.error(`Yahoo HTTP error....... ${response.status}`);
      return null;
    }
    if (!contentType.toLowerCase().includes("json")) {
      state.metrics.httpErrors += 1;
      throw new Error(
        `Yahoo returned non-JSON content (${contentType || "unknown content-type"}); no scraping attempted.`,
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      state.metrics.parsingErrors += 1;
      console.error(`Yahoo parsing error..... ${error.message}`);
      return null;
    }

    state.metrics.requestsSuccessful += 1;
    const chart = payload?.chart?.result?.[0];
    if (!chart || chart.meta?.symbol !== SYMBOL) {
      state.metrics.invalidSamples += 1;
      return null;
    }

    const sample = selectYahooPrice(chart, Date.now());
    if (!sample) {
      state.metrics.invalidSamples += 1;
      return null;
    }

    if (showAudit) {
      status("JSON structure", "chart.result[0]");
      status(`${SYMBOL} present`, "YES");
      status("Yahoo market state", sample.marketState);
      status("Selected field", sample.selectedField);
      status("Selected price", sample.price.toFixed(4));
      status("Timestamp basis", sample.timestampBasis);
    }

    state.metrics.validSamples += 1;
    verbose(
      `Valid sample received: ${sample.price.toFixed(4)} | ${sample.marketState} | ${sample.selectedField} | ${sample.timestamp}`,
    );
    return sample;
  } catch (error) {
    if (error.name === "AbortError") {
      state.metrics.httpErrors += 1;
      console.error(`Yahoo HTTP error....... request timed out after ${REQUEST_TIMEOUT_MS} ms`);
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isNewSample(sample, previous) {
  return (
    !previous ||
    sample.timestampMs !== previous.timestampMs ||
    sample.price !== previous.price ||
    sample.marketState !== previous.marketState ||
    sample.selectedField !== previous.selectedField
  );
}

function acceptSampleTimestamp(state, sample) {
  if (sample.timestampMs < state.baseTimestampMs) {
    state.metrics.staleSamplesDiscarded += 1;
    console.log(
      `Sample discarded | STALE | Sample: ${sample.timestamp} | Reference: ${state.baseTimestamp}`,
    );
    return false;
  }

  if (
    state.lastAcceptedTimestampMs !== null &&
    sample.timestampMs < state.lastAcceptedTimestampMs
  ) {
    state.metrics.outOfOrderDiscarded += 1;
    console.log(
      `Sample discarded | OUT_OF_ORDER | Sample: ${sample.timestamp} | Reference: ${state.lastAcceptedTimestamp}`,
    );
    return false;
  }

  if (sample.timestampMs === state.lastAcceptedTimestampMs) {
    return false;
  }

  state.lastAcceptedTimestampMs = sample.timestampMs;
  state.lastAcceptedTimestamp = sample.timestamp;
  return true;
}

function printHeartbeat(state, sample) {
  const displayedState =
    state.currentState === STATES.POSITION_OPEN ? "POSITION_OPEN" : state.currentState;
  const arm = state.armTriggerPrice?.toFixed(4) ?? "-";
  const stop = state.stopPrice?.toFixed(4) ?? "-";
  const limit = state.limitPrice?.toFixed(4) ?? "-";
  const entry = state.position?.entryPrice?.toFixed(4) ?? "-";

  line("-");
  console.log(
    `Heartbeat | Elapsed: ${((Date.now() - state.startedAtMs) / 1000).toFixed(1)} s | Samples: ${state.metrics.uniqueSamples} | State: ${displayedState}`,
  );
  console.log(
    `Price: ${sample.price.toFixed(4)} | Arm: ${arm} | Stop: ${stop} | Limit: ${limit} | Entry: ${entry}`,
  );
}

function printEvent(title) {
  console.log();
  line();
  console.log(title);
  line();
}

function establishReference(state, sample) {
  state.firstRegularSample = sample;
  state.referencePrice =
    (state.lastPremarketSample.price + state.firstRegularSample.price) / 2;
  state.armTriggerPrice = state.referencePrice * (1 - ARM_DROP_PERCENT);
  state.stopPrice = state.referencePrice;
  state.limitPrice = state.referencePrice * (1 + LIMIT_PERCENT_STPL);
  state.strategyStartedAtMs = Date.now();
  transitionTo(state, STATES.WAITING_TRIGGER, "reference calculated");

  printEvent("REFERENCE CALCULATED");
  status("Last simulated premarket", state.lastPremarketSample.price.toFixed(4));
  status("First simulated regular", state.firstRegularSample.price.toFixed(4));
  status("Reference", state.referencePrice.toFixed(4));
  status("Arm trigger", state.armTriggerPrice.toFixed(4));
  status("Stop price", state.stopPrice.toFixed(4));
  status("Limit price", state.limitPrice.toFixed(4));
  status("Timestamp basis", sample.timestampBasis);
  status("Yahoo market state", sample.marketState);
}

function armStrategy(state, sample) {
  state.strategyArmed = true;
  state.armTimestamp = sample.timestamp;
  state.armTimestampMs = sample.timestampMs;
  state.armPrice = sample.price;
  state.armDropPercent = (sample.price / state.referencePrice - 1) * 100;

  printEvent("STRATEGY ARMED");
  status("Reference", state.referencePrice.toFixed(4));
  status("Trigger", state.armTriggerPrice.toFixed(4));
  status("Yahoo price", sample.price.toFixed(4));
  status("Drop", `${state.armDropPercent.toFixed(4)} %`);
  status("Timestamp", sample.timestamp);
  console.log("Simulation only. No order sent.");

  state.buyStopLimit = {
    stopPrice: state.stopPrice,
    limitPrice: state.limitPrice,
    quantity: SIMULATED_QUANTITY,
    createdTimestamp: sample.timestamp,
    state: "PENDING_STOP",
    activationPrice: null,
    activationTimestamp: null,
    fillPrice: null,
    fillTimestamp: null,
    cancelReason: null,
  };
  state.buyStopLimitCreated = true;
  transitionTo(
    state,
    STATES.WAITING_STOP_ACTIVATION,
    "simulated Buy Stop-Limit created",
  );

  printEvent("BUY STOP-LIMIT CREATED");
  status("Stop price", state.buyStopLimit.stopPrice.toFixed(4));
  status("Limit price", state.buyStopLimit.limitPrice.toFixed(4));
  status("Quantity", state.buyStopLimit.quantity);
  status("Order state", state.buyStopLimit.state);
  console.log("Simulation only. No order sent.");
}

function activateBuyStop(state, sample) {
  state.buyStopLimit.state = "ACTIVE_LIMIT";
  state.buyStopLimit.activationPrice = sample.price;
  state.buyStopLimit.activationTimestamp = sample.timestamp;
  state.stopActivated = true;
  state.stopActivationTimestamp = sample.timestamp;

  printEvent("BUY STOP ACTIVATED");
  status("Stop price", state.stopPrice.toFixed(4));
  status("Activation price", sample.price.toFixed(4));
  status("Activation timestamp", sample.timestamp);
  status("Order state", state.buyStopLimit.state);

  if (sample.price <= state.limitPrice) {
    fillBuyStopLimitAndCreateTakeProfit(state, sample);
  } else {
    transitionTo(
      state,
      STATES.WAITING_LIMIT_FILL,
      "Stop activated above Limit; waiting for fill",
    );
  }
}

function fillBuyStopLimitAndCreateTakeProfit(state, sample) {
  const entryPrice = Math.min(sample.price, state.limitPrice);
  state.buyStopLimit.state = "FILLED";
  state.buyStopLimit.fillPrice = entryPrice;
  state.buyStopLimit.fillTimestamp = sample.timestamp;
  state.limitFilled = true;

  printEvent("BUY STOP-LIMIT FILLED");
  status("Entry price", entryPrice.toFixed(4));
  status("Fill timestamp", sample.timestamp);
  status("Quantity", state.buyStopLimit.quantity);

  state.position = {
    entryPrice,
    limitPrice: state.limitPrice,
    quantity: SIMULATED_QUANTITY,
    entryTimestamp: sample.timestamp,
    openedAtMs: Date.now(),
    status: "OPEN",
    exitPrice: null,
    exitTimestamp: null,
    exitReason: null,
  };
  state.simulatedBuyCreated = true;
  state.takeProfit = {
    price: entryPrice * (1 + TAKE_PROFIT_PERCENT),
    status: "ACTIVE",
  };
  transitionTo(state, STATES.POSITION_OPEN, "simulated Buy Stop-Limit filled");

  console.log();
  console.log("TP WOULD BE CREATED HERE");
  status("Simulated TP", state.takeProfit.price.toFixed(4));
  status("TP gain", `${(TAKE_PROFIT_PERCENT * 100).toFixed(2)}%`);
  console.log("No order sent.");
}

function cancelBuyStopLimit(state, reason) {
  if (!["PENDING_STOP", "ACTIVE_LIMIT"].includes(state.buyStopLimit?.state)) {
    return;
  }
  const previousState = state.buyStopLimit.state;
  state.buyStopLimit.state = "CANCELLED";
  state.buyStopLimit.cancelReason = reason;
  state.orderCancelled = true;

  printEvent("BUY STOP-LIMIT CANCELLED");
  status("Previous state", previousState);
  status("Reason", reason);
  console.log("Simulation only.");
}

function closeAtTakeProfit(state, sample) {
  printEvent("TP WOULD BE EXECUTED HERE");
  status("Yahoo price", sample.price.toFixed(4));
  status("Simulated TP", state.takeProfit.price.toFixed(4));
  status("Timestamp", sample.timestamp);

  state.takeProfit.status = "SIMULATED_EXECUTED";
  state.position.status = "CLOSED";
  state.position.exitPrice = sample.price;
  state.position.exitTimestamp = sample.timestamp;
  state.position.exitReason = "TAKE_PROFIT";
  transitionTo(state, STATES.POSITION_CLOSED_TP, "simulated Take Profit reached");
  state.finished = true;
  console.log("Simulated position closed. No order sent.");
}

function closeAtTimeout(state, sample) {
  printEvent("TIMEOUT");
  console.log("POSITION WOULD BE CLOSED HERE");
  status("Last Yahoo price", sample?.price?.toFixed(4) ?? "unavailable");
  status("Position timeout", `${POSITION_TIMEOUT_MS / 1000} seconds`);

  state.takeProfit.status = "SIMULATED_CANCELLED_ON_TIMEOUT";
  state.position.status = "CLOSED";
  state.position.exitPrice = sample?.price ?? null;
  state.position.exitTimestamp = sample?.timestamp ?? new Date().toISOString();
  state.position.exitReason = "TIMEOUT";
  transitionTo(state, STATES.POSITION_CLOSED_TIMEOUT, "simulated position timeout");
  state.finished = true;
  console.log("Simulated position closed. No order sent.");
}

function closeForManualInterruption(state) {
  cancelBuyStopLimit(state, "MANUAL_INTERRUPTION");
  if (state.position?.status === "OPEN") {
    state.position.status = "CLOSED";
    state.position.exitPrice = state.latestValidSample?.price ?? null;
    state.position.exitTimestamp =
      state.latestValidSample?.timestamp ?? new Date().toISOString();
    state.position.exitReason = "MANUAL_INTERRUPTION";
    if (state.takeProfit) {
      state.takeProfit.status = "SIMULATED_CANCELLED_ON_INTERRUPTION";
    }
  }
  state.exitReason = "MANUAL_INTERRUPTION";
  transitionTo(state, STATES.INTERRUPTED, "Ctrl+C received");
  state.finished = true;
}

function processUniqueSample(state, sample) {
  state.metrics.uniqueSamples += 1;
  const previousSample = state.previousUniqueSample;
  state.previousUniqueSample = sample;
  state.lowestPrice =
    state.lowestPrice === null ? sample.price : Math.min(state.lowestPrice, sample.price);

  if (state.currentState === STATES.WAITING_REFERENCE) {
    if (state.simulatedOpenMs === null) {
      state.simulatedOpenMs = sample.timestampMs + SIMULATED_OPEN_DELAY_MS;
      state.simulatedOpenTimestamp = new Date(state.simulatedOpenMs).toISOString();
      printEvent("SIMULATED REFERENCE WINDOW");
      status("Base timestamp", state.baseTimestamp);
      status("Simulated open", state.simulatedOpenTimestamp);
      status("Initial Yahoo price", sample.price.toFixed(4));
      status("Yahoo market state", sample.marketState);
    }

    if (sample.timestampMs < state.simulatedOpenMs) {
      state.lastPremarketSample = sample;
    } else if (state.lastPremarketSample) {
      establishReference(state, sample);
    }
    return;
  }

  if (
    state.currentState === STATES.WAITING_TRIGGER &&
    sample.price <= state.armTriggerPrice
  ) {
    armStrategy(state, sample);
    return;
  }

  if (
    state.currentState === STATES.WAITING_STOP_ACTIVATION &&
    previousSample &&
    previousSample.price < state.stopPrice &&
    sample.price >= state.stopPrice
  ) {
    activateBuyStop(state, sample);
    return;
  }

  if (
    state.currentState === STATES.WAITING_LIMIT_FILL &&
    sample.price <= state.limitPrice
  ) {
    fillBuyStopLimitAndCreateTakeProfit(state, sample);
    return;
  }

  if (
    state.currentState === STATES.POSITION_OPEN &&
    sample.price >= state.takeProfit.price
  ) {
    closeAtTakeProfit(state, sample);
  }
}

function printFinalSummary(state) {
  const totalSeconds = (Date.now() - state.startedAtMs) / 1000;
  const finalPosition = state.position?.status === "OPEN" ? "OPEN" : "FLAT";
  const result =
    state.currentState === STATES.POSITION_CLOSED_TP
      ? "SUCCESS"
      : [
            STATES.POSITION_CLOSED_TIMEOUT,
            STATES.FINISHED_NO_ENTRY,
            STATES.PRE_REFERENCE_TIMEOUT,
          ].includes(state.currentState)
        ? "TIMEOUT"
        : state.currentState === STATES.ERROR
          ? "ERROR"
          : state.currentState === STATES.INTERRUPTED
            ? "INTERRUPTED"
            : "NO ENTRY";

  console.log();
  line();
  console.log("EXECUTION PLAYGROUND SUMMARY");
  line();
  status("Symbol", SYMBOL);
  status("Market data source", "YAHOO FINANCE");
  status("Requests attempted", state.metrics.requestsAttempted);
  status("Requests successful", state.metrics.requestsSuccessful);
  status("Valid samples", state.metrics.validSamples);
  status("Unique samples", state.metrics.uniqueSamples);
  status("Stale samples discarded", state.metrics.staleSamplesDiscarded);
  status("Out-of-order discarded", state.metrics.outOfOrderDiscarded);
  status("HTTP errors", state.metrics.httpErrors);
  status("Parsing errors", state.metrics.parsingErrors);
  status("Reference", state.referencePrice?.toFixed(4) ?? "-");
  status("Arm trigger", state.armTriggerPrice?.toFixed(4) ?? "-");
  status("Strategy armed", state.strategyArmed ? "YES" : "NO");
  status("Arm timestamp", state.armTimestamp ?? "-");
  status("Buy Stop-Limit Created", state.buyStopLimitCreated ? "YES" : "NO");
  status("Stop Price", state.stopPrice?.toFixed(4) ?? "-");
  status("Stop Activated", state.stopActivated ? "YES" : "NO");
  status("Stop Activation Time", state.stopActivationTimestamp ?? "-");
  status("Limit Price", state.limitPrice?.toFixed(4) ?? "-");
  status("Limit Filled", state.limitFilled ? "YES" : "NO");
  status("Order Cancelled", state.orderCancelled ? "YES" : "NO");
  status("Order Final State", state.buyStopLimit?.state ?? "NOT_CREATED");
  status("Simulated buy", state.simulatedBuyCreated ? "YES" : "NO");
  status("Entry price", state.position?.entryPrice?.toFixed(4) ?? "-");
  status("Quantity", state.position?.quantity ?? state.buyStopLimit?.quantity ?? "-");
  status("Simulated TP", state.takeProfit?.price?.toFixed(4) ?? "-");
  status("TP state", state.takeProfit?.status ?? "NOT_CREATED");
  status("Exit reason", state.position?.exitReason ?? state.exitReason ?? "-");
  status("Exit price", state.position?.exitPrice?.toFixed(4) ?? "-");
  status("Duration", `${totalSeconds.toFixed(1)} seconds`);
  status("Manual interruption", state.manualInterrupted ? "YES" : "NO");
  status("Final position", finalPosition);
  status("Final state", state.currentState);
  status("Orders sent", 0);
  status("Real positions changed", 0);
  status("Simulation result", result);
  printStateTransitions(state, result);
}

function printStateTransitions(state, result) {
  console.log();
  line();
  console.log("STATE TRANSITIONS");
  line();
  state.transitions.forEach((transition, index) => {
    console.log(transition);
    if (index < state.transitions.length - 1) {
      console.log("↓");
    }
  });
  console.log();
  console.log("RESULT:");
  console.log(result);
}

async function runStateMachine() {
  const startedAtMs = Date.now();
  const baseTimestampMs = Math.floor(startedAtMs / 1000) * 1000;
  const state = {
    startedAtMs,
    nextHeartbeatAtMs: startedAtMs + HEARTBEAT_INTERVAL_MS,
    currentState: STATES.STARTING,
    transitions: [],
    finished: false,
    manualInterrupted: false,
    metrics: {
      requestsAttempted: 0,
      requestsSuccessful: 0,
      validSamples: 0,
      uniqueSamples: 0,
      invalidSamples: 0,
      httpErrors: 0,
      parsingErrors: 0,
      staleSamplesDiscarded: 0,
      outOfOrderDiscarded: 0,
    },
    previousUniqueSample: null,
    latestValidSample: null,
    baseTimestampMs,
    baseTimestamp: new Date(baseTimestampMs).toISOString(),
    lastAcceptedTimestampMs: null,
    lastAcceptedTimestamp: null,
    simulatedOpenMs: null,
    simulatedOpenTimestamp: null,
    lastPremarketSample: null,
    firstRegularSample: null,
    referencePrice: null,
    armTriggerPrice: null,
    stopPrice: null,
    limitPrice: null,
    strategyStartedAtMs: null,
    strategyArmed: false,
    armTimestamp: null,
    armTimestampMs: null,
    armPrice: null,
    armDropPercent: null,
    buyStopLimit: null,
    buyStopLimitCreated: false,
    stopActivated: false,
    stopActivationTimestamp: null,
    limitFilled: false,
    orderCancelled: false,
    simulatedBuyCreated: false,
    takeProfit: null,
    position: null,
    lowestPrice: null,
    exitReason: null,
    errorMessage: null,
  };

  const handleSigint = () => {
    if (state.manualInterrupted) {
      return;
    }
    state.manualInterrupted = true;
    console.log();
    console.log("Manual interruption received (Ctrl+C).");
    console.log("Closing simulated state safely before exit.");
    closeForManualInterruption(state);
  };

  process.once("SIGINT", handleSigint);

  try {
    validateConfiguration();
    transitionTo(state, STATES.WAITING_REFERENCE, "configuration validated");
    const firstSample = await requestYahoo(state, true);
    if (state.manualInterrupted) {
      printFinalSummary(state);
      return state;
    }
    if (!firstSample) {
      throw new Error("Preflight connectivity succeeded but returned no valid Yahoo price.");
    }
    status("Configuration", "OK");
    status("Yahoo connectivity", "OK");
    status("Initial state", state.currentState);
    let pendingSample = firstSample;

    while (!state.finished) {
      const cycleStartedAt = Date.now();
      const sample = pendingSample ?? await requestYahoo(state);
      pendingSample = null;

      if (state.finished) {
        break;
      }

      const acceptedSample = sample && acceptSampleTimestamp(state, sample) ? sample : null;

      if (acceptedSample) {
        state.latestValidSample = acceptedSample;
        if (isNewSample(acceptedSample, state.previousUniqueSample)) {
          processUniqueSample(state, acceptedSample);
        } else {
          verbose("Duplicate Yahoo sample ignored by the state machine.");
        }
      }

      const now = Date.now();
      if (acceptedSample && now >= state.nextHeartbeatAtMs) {
        printHeartbeat(state, acceptedSample);
        while (state.nextHeartbeatAtMs <= now) {
          state.nextHeartbeatAtMs += HEARTBEAT_INTERVAL_MS;
        }
      }

      if (
        state.currentState === STATES.WAITING_REFERENCE &&
        now - state.startedAtMs >= PRE_REFERENCE_TIMEOUT_MS
      ) {
        transitionTo(state, STATES.PRE_REFERENCE_TIMEOUT, "reference timeout");
        state.exitReason = "PRE_REFERENCE_TIMEOUT";
        state.finished = true;
      } else if (
        [
          STATES.WAITING_TRIGGER,
          STATES.WAITING_STOP_ACTIVATION,
          STATES.WAITING_LIMIT_FILL,
        ].includes(state.currentState) &&
        now - state.strategyStartedAtMs >= STRATEGY_TIMEOUT_MS
      ) {
        printEvent("STRATEGY TIMEOUT");
        console.log("No simulated entry occurred within the configured strategy window.");
        cancelBuyStopLimit(state, "STRATEGY_TIMEOUT");
        transitionTo(state, STATES.FINISHED_NO_ENTRY, "strategy timeout before entry");
        state.exitReason = "STRATEGY_TIMEOUT_BEFORE_ENTRY";
        state.finished = true;
      } else if (
        state.currentState === STATES.POSITION_OPEN &&
        now - state.position.openedAtMs >= POSITION_TIMEOUT_MS
      ) {
        closeAtTimeout(state, state.latestValidSample);
      }

      if (!state.finished) {
        const cycleElapsed = Date.now() - cycleStartedAt;
        await delay(Math.max(0, POLLING_INTERVAL_MS - cycleElapsed));
      }
    }
  } catch (error) {
    if (!state.manualInterrupted) {
      state.errorMessage = error.message;
      state.exitReason = "ERROR";
      cancelBuyStopLimit(state, "OPERATIONAL_ERROR");
      if (state.position?.status === "OPEN") {
        state.position.status = "CLOSED";
        state.position.exitPrice = state.latestValidSample?.price ?? null;
        state.position.exitTimestamp =
          state.latestValidSample?.timestamp ?? new Date().toISOString();
        state.position.exitReason = "ERROR";
        if (state.takeProfit) {
          state.takeProfit.status = "SIMULATED_CANCELLED_ON_ERROR";
        }
      }
      transitionTo(state, STATES.ERROR, error.message);
      state.finished = true;
      console.error();
      status("Operational error", error.message);
    }
  } finally {
    process.removeListener("SIGINT", handleSigint);
  }

  printFinalSummary(state);
  if (state.currentState === STATES.ERROR) {
    process.exitCode = 1;
  }
  return state;
}

async function main() {
  line();
  console.log("JSB - EXECUTION PLAYGROUND / PHASE A");
  line();
  status("Symbol", SYMBOL);
  status("Market data", "YAHOO FINANCE / HTTP");
  status("Broker integration", "NONE");
  status("Execution", "FULLY SIMULATED");
  status("Orders enabled", "NO");
  console.log();
  status("Polling interval", `${POLLING_INTERVAL_MS / 1000} seconds`);
  status("Heartbeat interval", `${HEARTBEAT_INTERVAL_MS / 1000} seconds`);
  status("Strategy timeout", `${STRATEGY_TIMEOUT_MS / 1000} seconds`);
  status("Position timeout", `${POSITION_TIMEOUT_MS / 1000} seconds`);
  status("Arm drop", `${(ARM_DROP_PERCENT * 100).toFixed(2)}%`);
  status("Take Profit", `${(TAKE_PROFIT_PERCENT * 100).toFixed(2)}%`);
  status("Simulated quantity", SIMULATED_QUANTITY);
  console.log();

  await runStateMachine();
}

main().catch((error) => {
  console.error();
  status("Result", "ERROR");
  console.error(error.message);
  console.error("Orders sent: 0");
  console.error("Real positions changed: 0");
  process.exitCode = 1;
});
