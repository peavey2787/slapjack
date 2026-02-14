// kaspa_client.js
import {
  RpcClient,
  Resolver,
  ConnectStrategy,
} from "../kas-wasm/kaspa.js";
import { Logger, LogModule } from "../../../core/logger.js";

const log = Logger.create(LogModule.transport.kaspaClient);

let client = null;
let currentRpcUrl = null;
let currentNetworkId = null;

export async function connect({
  rpcUrl,
  networkId = "testnet-10",
  onDisconnect,
} = {}) {
  // 1. Shut down existing client
  if (client) {
    try {
      await client.disconnect();
      client.free(); // Many Rust-based WASM modules need this to release the "Heap"
      client = null; // Garbage Collect the JS reference
    } catch (e) {
      log.warn("Cleanup error:", e);
    }
    client = null;
  }

  // Store connection details for reconnect
  currentRpcUrl = rpcUrl;
  currentNetworkId = networkId;

  // 2. Set options
  const options = {
    networkId: networkId,
    resolver: rpcUrl ? undefined : new Resolver(),
    url: rpcUrl || undefined,
  };

  // 3. Create a single client and let the SDK handle node resolution
  client = new RpcClient(options);

  const isDirect = Boolean(rpcUrl);

  const connectOptions = isDirect
    ? {
        blockAsyncConnect: true,
        strategy: ConnectStrategy.Fallback,
        timeoutDuration: 5000,
      }
    : {
        blockAsyncConnect: true,         // block until actually connected
        strategy: ConnectStrategy.Retry, // try nodes, don't persist-loop forever
        retryInterval: 1000,
        timeoutDuration: 5000,           // give up after 5s
      };

  try {
    await client.connect(connectOptions);
  } catch (err) {
    log.warn("Connect error (blockAsync):", err);

    if (isDirect) {
      try {
        await client.disconnect();
      } catch (_) {
        /* */
      }
      try {
        client.free();
      } catch (_) {
        /* */
      }
      client = null;
      throw new Error(
        `Failed to connect to ${rpcUrl}: ${err?.message || String(err)}`,
      );
    }
  }

  // If blockAsync didn't yield a connection, poll briefly as a fallback
  if (!client.isConnected && !isDirect) {
    const pollEnd = Date.now() + 5000;
    while (!client.isConnected && Date.now() < pollEnd) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!client.isConnected) {
    log.error("Could not connect to any Kaspa node within timeout");
    try { await client.disconnect(); } catch (_) { /* */ }
    try { client.free(); } catch (_) { /* */ }
    client = null;
    throw new Error("Kaspa node connection timeout");
  }

  // Subscribe to disconnect event
  if (client && typeof client.on === "function") {
    client.on("disconnect", async () => {
      log.warn("Disconnected from Kaspa node");
      if (typeof onDisconnect === "function") {
        await onDisconnect();
      }
    });
  }

  if (rpcUrl) {
    log.log(
      `Connected to Kaspa node at ${rpcUrl} on network ${currentNetworkId}`,
    );
  } else {
    log.log(
      `Connected to public Kaspa node via resolver on network ${currentNetworkId}`,
    );
  }

  return client;
}
