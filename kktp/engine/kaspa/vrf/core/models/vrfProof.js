// VRFProof.js
import { Block } from "./Block.js";

export class VRFProof {
  // 1. Added iterations to the destructured object here
  constructor({ btc, kaspa, nist, finalOutput, seed, iterations }) {
    this.evidence = {
      btc: btc.map((b) => new Block(b)),
      kaspa: kaspa.map((k) => new Block(k)),
      nist: new Block(nist),
    };
    this.finalOutput = finalOutput;
    this.seed = seed;
    // 2. Assign it to the instance so it's actually saved
    this.iterations = iterations; 
    this.timestamp = Date.now();
  }
}