// logger.js

let currentProvider = console;

const noopLogger = {
  log: () => {},
  error: () => {},
};

/**
 * Internal helper to ensure metadata/objects don't render as [object Object]
 */
const formatMeta = (meta) => {
  if (meta === "" || meta === undefined) return "";
  return typeof meta === "object" ? JSON.stringify(meta) : meta;
};

export function setLoggerProvider(provider) {
  if (provider === true) {
    currentProvider = console;
  } else if (provider === false) {
    currentProvider = noopLogger;
  } else if (
    provider &&
    typeof provider.log === "function" &&
    typeof provider.error === "function"
  ) {
    currentProvider = provider;
  } else {
    throw new Error(
      "Invalid logger provider: must implement .log() and .error(), or pass true/false.",
    );
  }
}

export function logInfo(msg, meta = "") {
  const message = typeof msg === "string" ? msg : JSON.stringify(msg);
  // Now meta is stringified before being passed to the provider
  currentProvider.log(
    `[INFO] ${new Date().toISOString()} - ${message}`,
    formatMeta(meta),
  );
}

export function logError(msg, meta = "") {
  const message = typeof msg === "string" ? msg : JSON.stringify(msg);
  // Now meta is stringified before being passed to the provider
  currentProvider.error(
    `[ERROR] ${new Date().toISOString()} - ${message}`,
    formatMeta(meta),
  );
}
