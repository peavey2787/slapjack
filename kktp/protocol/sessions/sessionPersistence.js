// kktp/protocol/sessions/sessionPersistence.js
// IndexedDB persistence layer for KKTP sessions

export class SessionPersistence {
  constructor({
    dbName = "KKTP_DB",
    version = 1,
    sessionStore = "sessions",
    snapshotStore = "dashboard_snapshots",
    peerStore = "peer_registry",
    metaStore = "meta",
  } = {}) {
    this.dbName = dbName;
    this.version = version;
    this.sessionStore = sessionStore;
    this.snapshotStore = snapshotStore;
    this.peerStore = peerStore;
    this.metaStore = metaStore;
    this._dbPromise = null;
    this._recreatedOnce = false;
  }

  // ─────────────────────────────────────────────────────────────
  // Peer Registry: Per-contact baseIndex allocation with PFS
  // ─────────────────────────────────────────────────────────────

  /**
   * Upsert a peer record (keyed by peerPubSig).
   * @param {Object} record - { peerPubSig, baseIndex, usedBranches: [], createdAt, updatedAt }
   */
  async upsertPeerRecord(record) {
    if (typeof indexedDB === "undefined" || !record?.peerPubSig) return false;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.peerStore, "readwrite");
      const store = tx.objectStore(this.peerStore);
      store.put({ ...record, updatedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Get a peer record by peerPubSig.
   */
  async getPeerRecord(peerPubSig) {
    if (typeof indexedDB === "undefined" || !peerPubSig) return null;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.peerStore, "readonly");
      const store = tx.objectStore(this.peerStore);
      const req = store.get(peerPubSig);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Get all peer records.
   */
  async getAllPeerRecords() {
    if (typeof indexedDB === "undefined") return [];
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.peerStore, "readonly");
      const store = tx.objectStore(this.peerStore);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Mark a branch index as "used" for PFS (never reuse).
   * @param {string} peerPubSig
   * @param {number} branchIndex - The TX or RX index used
   */
  async markPeerBranchUsed(peerPubSig, branchIndex) {
    if (!peerPubSig || branchIndex == null) return false;
    const record = await this.getPeerRecord(peerPubSig);
    if (!record) return false;
    const usedBranches = new Set(record.usedBranches || []);
    usedBranches.add(branchIndex);
    record.usedBranches = [...usedBranches];
    return await this.upsertPeerRecord(record);
  }

  // ─────────────────────────────────────────────────────────────
  // Meta Store: Global counters (e.g., nextBaseIndex)
  // ─────────────────────────────────────────────────────────────

  /**
   * Get a meta value by key.
   */
  async getMeta(key) {
    if (typeof indexedDB === "undefined" || !key) return null;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.metaStore, "readonly");
      const store = tx.objectStore(this.metaStore);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Set a meta value by key.
   */
  async setMeta(key, value) {
    if (typeof indexedDB === "undefined" || !key) return false;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.metaStore, "readwrite");
      const store = tx.objectStore(this.metaStore);
      store.put({ key, value, updatedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Session Resume Records
  // ─────────────────────────────────────────────────────────────

  async putResumeRecord(record) {
    if (typeof indexedDB === "undefined") return false;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.sessionStore, "readwrite");
      const store = tx.objectStore(this.sessionStore);
      store.put(record);

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async getResumeRecord(prefix, sid) {
    if (typeof indexedDB === "undefined" || !sid) return null;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.sessionStore, "readonly");
      const store = tx.objectStore(this.sessionStore);
      const req = store.get(sid);

      req.onsuccess = () => {
        const rec = req.result;
        if (rec && rec.prefix === prefix) resolve(rec);
        else resolve(null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteResumeRecord(sid) {
    if (typeof indexedDB === "undefined" || !sid) return false;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.sessionStore, "readwrite");
      const store = tx.objectStore(this.sessionStore);
      store.delete(sid);

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async findLatestResumeRecord(prefix) {
    if (typeof indexedDB === "undefined") return null;
    const db = await this._openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.sessionStore, "readonly");
      const store = tx.objectStore(this.sessionStore);
      const index = store.index("prefix");

      let best = null;
      const req = index.openCursor(IDBKeyRange.only(prefix));

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(best);
          return;
        }

        const rec = cursor.value;
        if (rec && (!best || (rec.savedAt || 0) > (best.savedAt || 0))) {
          best = rec;
        }

        cursor.continue();
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // IndexedDB Management
  // ─────────────────────────────────────────────────────────────

  async _openDb() {
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion || 0;

        // Version 1 stores
        if (!db.objectStoreNames.contains(this.sessionStore)) {
          const store = db.createObjectStore(this.sessionStore, {
            keyPath: "sid",
          });
          store.createIndex("prefix", "prefix", { unique: false });
          store.createIndex("savedAt", "savedAt", { unique: false });
        }
        if (
          this.snapshotStore &&
          !db.objectStoreNames.contains(this.snapshotStore)
        ) {
          const snapshotStore = db.createObjectStore(this.snapshotStore, {
            keyPath: "id",
          });
          snapshotStore.createIndex("savedAt", "savedAt", { unique: false });
        }

        // Version 2 stores: peer_registry + meta
        if (oldVersion < 2) {
          if (
            this.peerStore &&
            !db.objectStoreNames.contains(this.peerStore)
          ) {
            const peerStore = db.createObjectStore(this.peerStore, {
              keyPath: "peerPubSig",
            });
            peerStore.createIndex("baseIndex", "baseIndex", { unique: true });
            peerStore.createIndex("updatedAt", "updatedAt", { unique: false });
          }
          if (
            this.metaStore &&
            !db.objectStoreNames.contains(this.metaStore)
          ) {
            db.createObjectStore(this.metaStore, { keyPath: "key" });
          }
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        const hasPeers = db.objectStoreNames.contains(this.peerStore);
        const hasMeta = db.objectStoreNames.contains(this.metaStore);

        if ((!hasPeers || !hasMeta) && !this._recreatedOnce) {
          this._recreatedOnce = true;
          db.close();
          const del = indexedDB.deleteDatabase(this.dbName);
          del.onsuccess = () => {
            this._dbPromise = null;
            this._openDb().then(resolve).catch(reject);
          };
          del.onerror = () => reject(del.error);
          return;
        }

        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });

    return this._dbPromise;
  }
}
