// rpc_runner.js

import { Logger, LogModule } from "../../../core/logger.js";

const log = Logger.create(LogModule.transport.rpcRunner);

/**
 * Run a JSON-RPC command on the given Kaspa RPC client.
 * The provided RPC Client must already be connected.
 * @param {Object} client - The Kaspa RPC client instance (must be connected).
 * @param {string} cmdText - JSON string with { method, params } for the RPC call.
 * @returns {Promise<string>} The result of the RPC call as a string, or error message.
 */
export async function runRpcCommand(client, cmdText) {
  if (!client || !client.isConnected) {
    return "Not connected to any RPC";
  }

  try {
    if (!cmdText) return "No command provided";
    const cmd = JSON.parse(cmdText);

    const methodName = cmd.method;
    const params = cmd.params || {};

    if (typeof client[methodName] !== "function") {
      return `Method ${methodName} not found on RpcClient`;
    }

    const result = await client[methodName](params);

    if (typeof result === "object") {
      return Object.entries(result)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
    } else {
      return String(result);
    }
  } catch (err) {
    log.error("[RpcRunner] Error running RPC command:", err);
    return "Error: " + err;
  }
}
