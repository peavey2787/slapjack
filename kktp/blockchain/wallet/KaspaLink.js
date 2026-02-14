/**
 * KaspaLink.js - Adapter bridge
 */

export class KaspaLink {
  constructor(adapter = null) {
    this._adapter = adapter;
  }

  setAdapter(adapter) {
    this._adapter = adapter;
  }

  get adapter() {
    return this._adapter;
  }

  get address() {
    return this._adapter?.address?.toString?.() ?? null;
  }

  _requireAdapter(action) {
    if (!this._adapter) {
      throw new Error(`KaspaAdapter not set (${action})`);
    }
    return this._adapter;
  }

  async manualSend(params) {
    return await this._requireAdapter("manualSend").manualSend(params);
  }

  async getBalance(address) {
    return await this._requireAdapter("getBalance").getBalance(address);
  }

  async getPrivateKeys(params) {
    return await this._requireAdapter("getPrivateKeys").getPrivateKeys(params);
  }

  async splitUtxos(params) {
    return await this._requireAdapter("splitUtxos").splitUtxos(params);
  }

  startHeartbeat(params) {
    return this._requireAdapter("startHeartbeat").startHeartbeat(params);
  }

  stopHeartbeat() {
    return this._requireAdapter("stopHeartbeat").stopHeartbeat();
  }

  async getUtxos(address) {
    return await this._requireAdapter("getUtxos").getUtxos(address);
  }

  async consolidateUtxos(params) {
    return await this._requireAdapter("consolidateUtxos").consolidateUtxos(params);
  }

  async walkDagRange(params) {
    return await this._requireAdapter("walkDagRange").walkDagRange(params);
  }

  async getBitcoinBlocks() {
    const adapter = this._adapter;
    if (!adapter?.getBitcoinBlocks) return null;
    return await adapter.getBitcoinBlocks();
  }

  async getQRNG() {
    const adapter = this._adapter;
    if (!adapter?.getQRNG) return null;
    return await adapter.getQRNG();
  }

  async prove(params) {
    return await this._requireAdapter("prove").prove(params);
  }

  onNewBlock(handler) {
    const adapter = this._adapter;
    if (!adapter?.onNewBlock) return null;
    return adapter.onNewBlock(handler);
  }

  startScanner() {
    const adapter = this._adapter;
    return adapter?.startScanner?.();
  }

  setHeartbeatAnchorsEnabled(enabled) {
    return this._adapter?.setHeartbeatAnchorsEnabled?.(enabled);
  }
}

export default KaspaLink;
