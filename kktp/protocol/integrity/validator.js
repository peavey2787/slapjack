// validator.js

import discoverySchema from "../schemas/discovery.json" with { type: "json" };
import responseSchema from "../schemas/response.json" with { type: "json" };
import mailboxMessageSchema from "../schemas/message.json" with { type: "json" };
import sessionEndSchema from "../schemas/sessionEnd.json" with { type: "json" };

/**
 * Custom Error for KKTP Validation
 */
export class KKTPValidationError extends Error {
  constructor(message, path) {
    super(`${message} at [${path}]`);
    this.name = "KKTPValidationError";
    this.path = path;
  }
}

export class KKTPValidator {
  #schema;
  #name;

  constructor(schema, { name = "default" } = {}) {
    this.#schema = schema;
    this.#name = name;
  }

  /**
   * Validates an object against the schema.
   * Throws KKTPValidationError if invalid.
   */
  validate(obj) {
    this._validateSchema(this.#schema, obj, this.#name);
    return true;
  }

  _validateSchema(schema, value, path) {
    // 1. Check Required / Nullability
    if (schema.required && (value === undefined || value === null)) {
      throw new KKTPValidationError("Value is required", path);
    }

    if (value === undefined || value === null) {
      if (schema.type === "null" || !schema.required) return;
      throw new KKTPValidationError("Value cannot be null/undefined", path);
    }

    // 2. Check Type
    if (schema.type) this._checkType(schema.type, value, path);

    // 3. Check Enums
    if (schema.enum && !schema.enum.includes(value)) {
      throw new KKTPValidationError(
        `Value "${value}" not in enum [${schema.enum.join(", ")}]`,
        path,
      );
    }

    // 4. Check Regex Patterns (Strict Hex checking)
    // Skip pattern check if value is null (for optional fields like VRF)
    if (schema.pattern && value !== null) {
      const re =
        schema.pattern instanceof RegExp
          ? schema.pattern
          : new RegExp(schema.pattern);
      if (typeof value !== "string" || !re.test(value)) {
        throw new KKTPValidationError(
          `Value "${value}" does not match pattern ${re}`,
          path,
        );
      }
    }

    // 5. Recurse into Objects
    if (schema.type === "object" && schema.properties) {
      this._validateObject(schema, value, path);
    }

    // 6. Recurse into Arrays
    if (schema.type === "array" && schema.items) {
      this._validateArray(schema, value, path);
    }
  }

  _checkType(expected, value, path) {
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

    // Support union types like ["string", "null"] for optional VRF fields
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) {
        throw new KKTPValidationError(
          `Expected type "${expected.join("|")}" but got "${actual}"`,
          path,
        );
      }
      return;
    }

    if (expected === "number") {
      if (actual !== "number" || !Number.isFinite(value)) {
        throw new KKTPValidationError("Expected finite number", path);
      }
      return;
    }

    if (expected !== actual) {
      throw new KKTPValidationError(
        `Expected type "${expected}" but got "${actual}"`,
        path,
      );
    }
  }

  _validateObject(schema, obj, path) {
    const props = schema.properties || {};
    const keys = Object.keys(obj);

    // Check for missing required keys
    for (const [key, propSchema] of Object.entries(props)) {
      if (propSchema.required && !(key in obj)) {
        throw new KKTPValidationError(`Missing required field "${key}"`, path);
      }
    }

    // Validate existing keys
    for (const key of keys) {
      if (key in props) {
        this._validateSchema(props[key], obj[key], `${path}.${key}`);
      }
    }

    // Handle additionalProperties: false logic
    const additional = schema.additionalProperties;
    const isTopLevel = path === this.#name;

    if (additional === false) {
      for (const key of keys) {
        if (!(key in props)) {
          // Protocol Exception: Only allow 'meta' at top level for Discovery anchors (§5.2)
          if (isTopLevel && key === "meta" && this.#name === "discovery") continue;
          throw new KKTPValidationError(
            `Unexpected field "${key}"`,
            `${path}.${key}`,
          );
        }
      }
    }
  }

  _validateArray(schema, arr, path) {
    if (!Array.isArray(arr)) {
      throw new KKTPValidationError("Expected array", path);
    }

    const itemSchema = schema.items;
    for (let i = 0; i < arr.length; i++) {
      this._validateSchema(itemSchema, arr[i], `${path}[${i}]`);
    }
  }
}

// ---- Ready-to-use Singleton Instances ----

export const discoveryValidator = new KKTPValidator(discoverySchema, {
  name: "discovery",
});
export const responseValidator = new KKTPValidator(responseSchema, {
  name: "response",
});
export const sessionEndValidator = new KKTPValidator(sessionEndSchema, {
  name: "sessionEnd",
});
export const mailboxMessageValidator = new KKTPValidator(mailboxMessageSchema, {
  name: "message",
});
