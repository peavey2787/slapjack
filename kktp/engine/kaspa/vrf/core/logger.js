import { Logger, LogModule } from "../../../../core/logger.js";

const log = Logger.create(LogModule.vrf.core.logger);

// Simple structured logger for core
export function logInfo(msg, meta) {
  log.info(`${msg}`, meta || "");
}

export function logError(msg, meta) {
  log.error(`${msg}`, meta || "");
}
