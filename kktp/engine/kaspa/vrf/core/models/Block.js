export class Block {
  constructor(data) {
    // --- CORE IDENTITY ---
    this.hash = data.hash;
    this.source = data.source || "kaspa";
    this.pulseIndex = data.pulseIndex || 0;

    // Temporal Data (MS from Kaspa)
    this.timestamp = data.timestamp || data.time || data.timeStamp || 0;

    // --- PROVABILITY & DAG DATA ---
    this.blueScore = data.blueScore || 0;
    this.daaScore = data.daaScore || 0; // Essential for window-based VRF
    this.parents = data.parents || [];

    // Cryptographic signature/proof
    this.signature = data.signatureValue || data.signature || "";

    // VRF Seed: Entropy source
    this.seedValue = data.seedValue || data.hash;

    // --- CONSENSUS STATE ---
    this.confirms = data.confirms || 0;
    this.isFinal =
      this.source === "nist" || this.confirms >= 20 || !!this.blueScore;
  }

  /**
   * Static helper for Kaspa WASM integration
   */
  static fromKaspa(rawBlock, blueScore) {
    // Extract header safely
    const header = rawBlock.header || rawBlock;

    // Extract parents safely
    const parents = header.parents
      ? Array.from(header.parents).map((p) => p.toString())
      : [];

    return new Block({
      hash: header.hash?.toString() || rawBlock.hash?.toString(),
      timestamp: Number(header.timestamp || rawBlock.timestamp),
      blueScore: Number(blueScore || header.blueScore || 0),
      daaScore: Number(header.daaScore || 0),
      parents: parents,
      source: "kaspa"
    });
  }

  /**
   * Split NIST 512-bit hashes for 256-bit compatibility
   */
  static fromNistSplit(qrngBlock) {
    const metadata = {
      timestamp: qrngBlock.time || qrngBlock.timeStamp,
      source: "nist",
      pulseIndex: qrngBlock.pulseIndex || qrngBlock.index || 0,
      signature: qrngBlock.signatureValue || qrngBlock.signature,
      seedValue: qrngBlock.seedValue,
      daaScore: 0, // Not applicable to NIST
      parents: [],
    };

    return [
      new Block({ ...metadata, hash: qrngBlock.hash.substring(0, 64) }),
      new Block({ ...metadata, hash: qrngBlock.hash.substring(64, 128) }),
    ];
  }
}
