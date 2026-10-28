import { NexwardValidationError } from "./errors.ts";

// The callback must receive exactly what Nexward evaluated (threat model T5).
// Only plain JSON values survive the round trip unchanged, so anything else is
// rejected up front instead of being silently altered by serialization.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Returns a deep copy of `value` if it is plain JSON; throws otherwise. */
export function cloneJson(value: unknown, path = "arguments", seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NexwardValidationError(`${path} must be a finite number`);
    return value;
  }
  if (typeof value !== "object") {
    throw new NexwardValidationError(`${path} has unsupported type ${typeof value}`);
  }
  if (seen.has(value)) throw new NexwardValidationError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown, i) => {
        if (item === undefined) throw new NexwardValidationError(`${path}[${String(i)}] is undefined`);
        return cloneJson(item, `${path}[${String(i)}]`, seen);
      });
    }
    if (!isPlainObject(value)) {
      throw new NexwardValidationError(`${path} must be a plain object (got ${value.constructor.name})`);
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new NexwardValidationError(`${path}.${key} is undefined`);
      out[key] = cloneJson(item, `${path}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
