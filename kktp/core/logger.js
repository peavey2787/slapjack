let _enabled = true;
const _modules = {}; // e.g. { "transport": true, "transport.txBuilder": false }

export const LogModule = Object.freeze({
  core: Object.freeze({
    root: "core",
    eventEmitter: "core.eventEmitter",
  }),
  transport: Object.freeze({
    root: "transport",
    heartbeat: "transport.heartbeat",
    kaspaClient: "transport.kaspaClient",
    rpcRunner: "transport.rpcRunner",
    transportFacade: "transport.transportFacade",
    txBuilder: "transport.txBuilder",
    utxoManager: "transport.utxoManager",
    utxoOperations: "transport.utxoOperations",
  }),
  intelligence: Object.freeze({
    root: "intelligence",
    dagWalk: "intelligence.dagWalk",
    indexer: "intelligence.indexer",
    intelligenceFacade: "intelligence.intelligenceFacade",
    scanner: "intelligence.scanner",
  }),
  identity: Object.freeze({
    root: "identity",
    identityFacade: "identity.identityFacade",
    storage: "identity.storage",
    walletService: "identity.walletService",
  }),
  crypto: Object.freeze({
    root: "crypto",
    cryptoFacade: "crypto.cryptoFacade",
    dhEncryption: "crypto.dhEncryption",
    encryption: "crypto.encryption",
  }),
  vrf: Object.freeze({
    root: "vrf",
    vrfFacade: "vrf.vrfFacade",
    core: Object.freeze({
      root: "vrf.core",
      config: "vrf.core.config",
      constants: "vrf.core.constants",
      crypto: "vrf.core.crypto",
      errors: "vrf.core.errors",
      extractor: "vrf.core.extractor",
      folding: "vrf.core.folding",
      logger: "vrf.core.logger",
      nist: "vrf.core.nist",
      nistVerifier: "vrf.core.nistVerifier",
      fetcher: Object.freeze({
        root: "vrf.core.fetcher",
        bitcoin: "vrf.core.fetcher.bitcoin",
        cache: "vrf.core.fetcher.cache",
        index: "vrf.core.fetcher.index",
        kaspa: "vrf.core.fetcher.kaspa",
        qrngFetcher: "vrf.core.fetcher.qrngFetcher",
        qrng: "vrf.core.fetcher.qrng",
        utilities: "vrf.core.fetcher.utilities",
      }),
      logs: Object.freeze({
        root: "vrf.core.logs",
        logger: "vrf.core.logs.logger",
      }),
      models: Object.freeze({
        root: "vrf.core.models",
        block: "vrf.core.models.block",
        vrfProof: "vrf.core.models.vrfProof",
      }),
      tests: Object.freeze({
        root: "vrf.core.tests",
        basic: "vrf.core.tests.basic",
        binaryMatrixRank: "vrf.core.tests.binaryMatrixRank",
        gamma: "vrf.core.tests.gamma",
        linearComplexity: "vrf.core.tests.linearComplexity",
        maurerUniversal: "vrf.core.tests.maurerUniversal",
        randomExcursions: "vrf.core.tests.randomExcursions",
        spectralDft: "vrf.core.tests.spectralDft",
        templateMatching: "vrf.core.tests.templateMatching",
        utilities: "vrf.core.tests.utilities",
      }),
      unitTests: Object.freeze({
        root: "vrf.core.unitTests",
        bitcoinUnitTest: "vrf.core.unitTests.bitcoinUnitTest",
        cachePersistUnitTest: "vrf.core.unitTests.cachePersistUnitTest",
        foldingUnitTest: "vrf.core.unitTests.foldingUnitTest",
        kaspaUnitTest: "vrf.core.unitTests.kaspaUnitTest",
        qrngUnitTest: "vrf.core.unitTests.qrngUnitTest",
        testDashboard: "vrf.core.unitTests.testDashboard",
        vrfTests: "vrf.core.unitTests.vrfTests",
      }),
    }),
  }),
  kktp: Object.freeze({
    root: "kktp",
    kkGameEngine: "kktp.kkGameEngine",
    kaspaPortal: "kktp.kaspaPortal",
  }),
  protocol: Object.freeze({
    root: "protocol",
    sessions: Object.freeze({
      root: "protocol.sessions",
      sessionFacade: "protocol.sessions.sessionFacade",
      sessionVault: "protocol.sessions.sessionVault",
      keyDeriver: "protocol.sessions.keyDeriver",
    }),
  }),
  lobby: Object.freeze({
    root: "lobby",
    lobbyManager: "lobby.lobbyManager",
    lobbyMessageHandler: "lobby.lobbyMessageHandler",
    index: "lobby.index",
    lobbyCodec: "lobby.lobbyCodec",
    lobbyFacade: "lobby.lobbyFacade",
    lobbySchemas: "lobby.lobbySchemas",
    parts: Object.freeze({
      root: "lobby.parts",
      index: "lobby.parts.index",
      lobbyContext: "lobby.parts.lobbyContext",
      lobbyDiscovery: "lobby.parts.lobbyDiscovery",
      lobbyDmBuffer: "lobby.parts.lobbyDmBuffer",
      lobbyJoins: "lobby.parts.lobbyJoins",
      lobbyKeys: "lobby.parts.lobbyKeys",
      lobbyMessaging: "lobby.parts.lobbyMessaging",
      lobbyPersistence: "lobby.parts.lobbyPersistence",
      lobbyRoster: "lobby.parts.lobbyRoster",
      lobbyRouting: "lobby.parts.lobbyRouting",
      lobbySessionEnd: "lobby.parts.lobbySessionEnd",
      lobbySubscriptions: "lobby.parts.lobbySubscriptions",
      lobbyUtils: "lobby.parts.lobbyUtils",
      lobbyUtxo: "lobby.parts.lobbyUtxo",
    }),
  }),
  anchor: Object.freeze({
    root: "anchor",
    anchorFinal: "anchor.anchorFinal",
    anchorGenesis: "anchor.anchorGenesis",
    anchorHeartbeat: "anchor.anchorHeartbeat",
    auditTrail: "anchor.auditTrail",
    binaryPacking: "anchor.binaryPacking",
    hashing: "anchor.hashing",
    kaspaAnchorFacade: "anchor.kaspaAnchorFacade",
    moveProcessor: "anchor.moveProcessor",
    stateSerializer: "anchor.stateSerializer",
    utxoManager: "anchor.utxoManager",
    utxoPool: "anchor.utxoPool",
    vrfOperations: "anchor.vrfOperations",
  }),
});

export const Logger = {
  setEnabled: (val) => {
    _enabled = !!val;
  },

  resetModules: () => {
    for (const key of Object.keys(_modules)) {
      delete _modules[key];
    }
  },

  setModuleEnabled: (name, enabled) => {
    _modules[name] = !!enabled;
  },

  isModuleEnabled: (name) => {
    if (!name) return _enabled;
    if (name in _modules) return _modules[name];
    const parts = String(name).split(".");
    while (parts.length > 1) {
      parts.pop();
      const parent = parts.join(".");
      if (parent in _modules) return _modules[parent];
    }
    return _enabled;
  },

  enableModule: (name) => {
    Logger.setModuleEnabled(name, true);
  },

  disableModule: (name) => {
    Logger.setModuleEnabled(name, false);
  },

  enableTransportLogs: () => Logger.enableModule(LogModule.transport.root),
  disableTransportLogs: () => Logger.disableModule(LogModule.transport.root),
  enableIntelligenceLogs: () => Logger.enableModule(LogModule.intelligence.root),
  disableIntelligenceLogs: () => Logger.disableModule(LogModule.intelligence.root),
  enableIdentityLogs: () => Logger.enableModule(LogModule.identity.root),
  disableIdentityLogs: () => Logger.disableModule(LogModule.identity.root),
  enableCryptoLogs: () => Logger.enableModule(LogModule.crypto.root),
  disableCryptoLogs: () => Logger.disableModule(LogModule.crypto.root),
  enableVrfLogs: () => Logger.enableModule(LogModule.vrf.root),
  disableVrfLogs: () => Logger.disableModule(LogModule.vrf.root),
  enableKktpLogs: () => Logger.enableModule(LogModule.kktp.root),
  disableKktpLogs: () => Logger.disableModule(LogModule.kktp.root),
  enableLobbyLogs: () => Logger.enableModule(LogModule.lobby.root),
  disableLobbyLogs: () => Logger.disableModule(LogModule.lobby.root),
  enableAnchorLogs: () => Logger.enableModule(LogModule.anchor.root),
  disableAnchorLogs: () => Logger.disableModule(LogModule.anchor.root),

  create: (name = 'KKTP') => {
    const prefix = (level) => `[${level}] ${name}:`;

    return {
      log:   (...args) => { if (Logger.isModuleEnabled(name)) console.log(prefix('LOG'), ...args); },
      debug: (...args) => { if (Logger.isModuleEnabled(name)) console.debug(prefix('DEBUG'), ...args); },
      info:  (...args) => { if (Logger.isModuleEnabled(name)) console.info(prefix('INFO'), ...args); },
      warn:  (...args) => { if (Logger.isModuleEnabled(name)) console.warn(prefix('WARN'), ...args); },
      error: (...args) => { if (Logger.isModuleEnabled(name)) console.error(prefix('ERROR'), ...args); },
      trace: (...args) => { if (Logger.isModuleEnabled(name)) console.trace(prefix('TRACE'), ...args); }
    };
  }
};

export default Logger;
