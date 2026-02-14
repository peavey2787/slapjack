// errors.js
// Centralized error classes for folding/extraction

export class GammaValidationError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = "GammaValidationError";
    this.meta = meta;
  }
}

export class FoldingValidationError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = "FoldingValidationError";
    this.meta = meta;
  }
}

export class FoldingExtractionError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = "FoldingExtractionError";
    this.meta = meta;
  }
}
