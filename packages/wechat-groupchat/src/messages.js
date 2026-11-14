/**
 * Vendored user-message builder.
 *
 * Mirrors `createUserMessage` from `@deepseek-ai/dsh-llm`: mint an id, clone,
 * then deep-freeze. Vendored so the plugin has no runtime dependency on
 * `@deepseek-ai/*` packages, which are not resolvable from a profile-installed
 * bundle's own module resolution.
 */
import crypto from "node:crypto";

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
}

/** Create one identified user-role message, frozen before publication. */
export function createUserMessage(input) {
    return deepFreeze(structuredClone({ ...input, id: crypto.randomUUID(), role: "user" }));
}
