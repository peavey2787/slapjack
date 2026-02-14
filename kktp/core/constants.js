/**
 * constants.js - Core protocol constants (v5 Union Binary Protocol)
 *
 * Action code 1 (MOVE) uses a 16-byte extended packet with X/Y/Z coordinates.
 * All other action codes use the standard 8-byte packet.
 * Codes 10-15 are "category headers" whose value field carries a sub-ID
 * resolved from customAbilitiesMap / customActionsMap at runtime.
 */

export const MSG_TYPE = {
  MOVE: 'move',
  EVENT: 'event',
  HEARTBEAT: 'heartbeat'
};

// ── Action Codes (4-bit, 0-15) ──────────────────────────────────────────────

/**
 * The hardcoded MOVE action code.  Action code 1 always uses the 16-byte
 * extended packet layout with X, Y, Z coordinates.
 */
export const MOVE_ACTION_CODE = 1;

export const ACTION_CODE = {
  NONE:           0,
  MOVE:           1,   // Extended 16-byte layout (x, y, z)
  HEALTH_CHANGE:  2,
  POWER_CHANGE:   3,
  STAMINA_CHANGE: 4,
  ARMOR_CHANGE:   5,
  AMMO_CHANGE:    6,
  SCORE_CHANGE:   7,
  COLLECT_COIN:   8,
  LANE_CHANGE:    9,
  ABILITY:       10,   // Category header — sub-ID in value field
  ITEM:          11,   // Category header — sub-ID in value field
  STATUS:        12,   // Category header — sub-ID in value field
  ACTION:        13,   // Category header — sub-ID in value field
  EMOTE:         14,   // Category header — sub-ID in value field
  SYSTEM:        15,   // Category header — sub-ID in value field
};

export const ACTION_TO_CODE = {
  none:           ACTION_CODE.NONE,
  move:           ACTION_CODE.MOVE,
  health_change:  ACTION_CODE.HEALTH_CHANGE,
  power_change:   ACTION_CODE.POWER_CHANGE,
  stamina_change: ACTION_CODE.STAMINA_CHANGE,
  armor_change:   ACTION_CODE.ARMOR_CHANGE,
  ammo_change:    ACTION_CODE.AMMO_CHANGE,
  score_change:   ACTION_CODE.SCORE_CHANGE,
  collect_coin:   ACTION_CODE.COLLECT_COIN,
  lane_change:    ACTION_CODE.LANE_CHANGE,
  ability:        ACTION_CODE.ABILITY,
  item:           ACTION_CODE.ITEM,
  status:         ACTION_CODE.STATUS,
  action:         ACTION_CODE.ACTION,
  emote:          ACTION_CODE.EMOTE,
  system:         ACTION_CODE.SYSTEM,
};

export const CODE_TO_ACTION = Object.fromEntries(
  Object.entries(ACTION_TO_CODE).map(([k, v]) => [v, k])
);

/** Codes that use a sub-ID in the value field */
export const CATEGORY_CODES = new Set([
  ACTION_CODE.ABILITY,
  ACTION_CODE.ITEM,
  ACTION_CODE.STATUS,
  ACTION_CODE.ACTION,
  ACTION_CODE.EMOTE,
  ACTION_CODE.SYSTEM,
]);

// ── Default Sub-Maps for category codes ─────────────────────────────────────

export const DEFAULT_ABILITIES_MAP = Object.freeze({
  shield: 1,
  heal: 2,
  boost: 3,
});

export const DEFAULT_ACTIONS_MAP = Object.freeze({
  attack: 1,
  defend: 2,
  dodge: 3,
});

export const DEFAULT_ITEMS_MAP = Object.freeze({
  potion: 1,
  bomb: 2,
  key: 3,
});

export const DEFAULT_STATUS_MAP = Object.freeze({
  stun: 1,
  burn: 2,
  freeze: 3,
});

export const DEFAULT_EMOTES_MAP = Object.freeze({
  wave: 1,
  taunt: 2,
  cheer: 3,
});

export const DEFAULT_SYSTEM_MAP = Object.freeze({
  ping: 1,
  sync: 2,
  ready: 3,
});

/**
 * Build merged action maps from defaults + custom overrides.
 *
 * @param {Object} [custom] - Developer-supplied overrides
 * @param {Object} [custom.actionMap]     - String→code overrides for ACTION_TO_CODE
 * @param {Object} [custom.abilitiesMap]  - String→subId overrides for ability category
 * @param {Object} [custom.actionsMap]    - String→subId overrides for action category
 * @param {Object} [custom.itemsMap]      - String→subId overrides for item category
 * @param {Object} [custom.statusMap]     - String→subId overrides for status category
 * @param {Object} [custom.emotesMap]     - String→subId overrides for emote category
 * @param {Object} [custom.systemMap]     - String→subId overrides for system category
 * @returns {{ actionToCode, codeToAction, subMaps }}
 */
export function buildActionMaps(custom = {}) {
  const actionToCode = { ...ACTION_TO_CODE, ...(custom.actionMap || {}) };
  const codeToAction = Object.fromEntries(
    Object.entries(actionToCode).map(([k, v]) => [v, k])
  );

  const subMaps = {
    [ACTION_CODE.ABILITY]: { ...DEFAULT_ABILITIES_MAP, ...(custom.abilitiesMap || {}) },
    [ACTION_CODE.ACTION]:  { ...DEFAULT_ACTIONS_MAP,   ...(custom.actionsMap   || {}) },
    [ACTION_CODE.ITEM]:    { ...DEFAULT_ITEMS_MAP,     ...(custom.itemsMap     || {}) },
    [ACTION_CODE.STATUS]:  { ...DEFAULT_STATUS_MAP,    ...(custom.statusMap    || {}) },
    [ACTION_CODE.EMOTE]:   { ...DEFAULT_EMOTES_MAP,    ...(custom.emotesMap    || {}) },
    [ACTION_CODE.SYSTEM]:  { ...DEFAULT_SYSTEM_MAP,    ...(custom.systemMap    || {}) },
  };

  // Build reverse sub-maps (id → string) for parsing
  const reverseSubMaps = {};
  for (const [code, map] of Object.entries(subMaps)) {
    reverseSubMaps[code] = Object.fromEntries(
      Object.entries(map).map(([k, v]) => [v, k])
    );
  }

  return { actionToCode, codeToAction, subMaps, reverseSubMaps };
}

// ── Coordinate helpers (14-bit signed fixed-point, 0.01 precision) ──────────

/** Encode a float coordinate to a 14-bit unsigned value (two's complement). */
export function encodeCoord14(value) {
  let raw = Math.round((value ?? 0) * 100);
  if (raw < -8192) raw = -8192;
  if (raw > 8191) raw = 8191;
  return raw < 0 ? raw + 16384 : raw;
}

/** Decode a 14-bit unsigned value back to a float coordinate. */
export function decodeCoord14(raw) {
  const v = raw & 0x3FFF;
  return (v >= 8192 ? v - 16384 : v) / 100;
}

// ── Anchor / Protocol Constants ─────────────────────────────────────────────

export const ANCHOR = Object.freeze({
  VERSION: 5,
  TYPE_GENESIS: 1,
  TYPE_HEARTBEAT: 2,
  TYPE_FINAL: 3,

  HEADER_SIZE: 55,
  GAME_ID_BYTES: 8,
  BLOCK_HASH_BYTES: 16,
  VRF_SEED_BYTES: 8,

  /** Standard packet size (action codes 0, 2-15) */
  MOVE_PACKET_SIZE: 8,
  /** Extended packet size for MOVE (action code 1, x/y/z) */
  MOVE_PACKET_SIZE_EXTENDED: 16,
  VRF_FRAGMENT_BYTES: 4,
  QRNG_PULSE_SIZE: 12,
  QRNG_PULSE_FRAGMENT_BYTES: 8,

  MAX_MOVES: 255,
  MAX_QRNG_PULSES: 3,

  TIME_DELTA_SCALE: 4,
  TIME_DELTA_MAX: 255,
  NOP_HEARTBEAT_MS: 1020,

  BTC_BLOCK_COUNT: 6,

  GENESIS_BASE_SIZE: 858,
  /** v5 header: +2 bytes for movesSectionLength (was 68 in v4) */
  HEARTBEAT_HEADER_SIZE: 70,
  /** v4 header size — used for backward-compatible parsing */
  HEARTBEAT_HEADER_SIZE_V4: 68,
  HEARTBEAT_DELTA_BTC_SIZE: 32,
  HEARTBEAT_DELTA_NIST_SIZE: 584,

  DELTA_FLAG_NONE: 0,
  DELTA_FLAG_BTC: 1,
  DELTA_FLAG_NIST: 2,

  FINAL_SIZE: 144,

  OUTCOME_COMPLETE: 1,
  OUTCOME_FORFEIT: 2,
  OUTCOME_TIMEOUT: 3,
  OUTCOME_CHEAT: 4,
});

export const BLOCKCHAIN = Object.freeze({
  ANCHOR_BATCH_MS: 500,
  ANCHOR_AMOUNT: '0.5',
  PREFIX_GAME_START: 'KKTP:GEN:',
  PREFIX_HEARTBEAT: 'KKTP:HRT:',
  PREFIX_GAME_END: 'KKTP:END:',
  PREFIX_GAME_START_HEX: '4b47454e',
  PREFIX_HEARTBEAT_HEX: '4b485254',
  PREFIX_GAME_END_HEX: '4b454e44',

  MOVE_COST_KAS: 0.0001,
  MOVE_INTERVAL_MS: 500,
  FULL_RACE_COST_KAS: 0.5,

  // UTXO Pool Configuration
  UTXO_SPLIT_COUNT: 10,
  UTXO_LOW_THRESHOLD: 3,
  UTXO_KEY_COUNT: 10,
  UTXO_HEARTBEAT_MS: 2000,
  UTXO_USABLE_THRESHOLD_KAS: 0.6,
  UTXO_HEARTBEAT_FIRST_DELAY_MS: 0,
});

/**
 * Return the byte size of a single move packet given its action code.
 * @param {number} actionCode
 * @returns {number} 16 for MOVE (code 1), 8 for everything else
 */
export function movePacketSize(actionCode) {
  return actionCode === MOVE_ACTION_CODE
    ? ANCHOR.MOVE_PACKET_SIZE_EXTENDED
    : ANCHOR.MOVE_PACKET_SIZE;
}

export default {
  MSG_TYPE,
  MOVE_ACTION_CODE,
  ACTION_CODE,
  ACTION_TO_CODE,
  CODE_TO_ACTION,
  CATEGORY_CODES,
  ANCHOR,
  BLOCKCHAIN,
  buildActionMaps,
  encodeCoord14,
  decodeCoord14,
  movePacketSize,
};
