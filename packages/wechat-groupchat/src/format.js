/**
 * Markdown → WeChat text.
 *
 * WeChat has no markdown renderer: `**粗体**` arrives as literal asterisks, and
 * a fenced block arrives with its backticks. The agent writes markdown, so the
 * channel flattens it to the closest plain-text reading instead of forwarding
 * the syntax. Deliberately conservative — it only removes markup, never
 * rewrites wording.
 */

const INLINE_RULES = [
    // `![alt](src)` and `[text](url)` → "text (url)"; the URL stays readable.
    [/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => (alt ? `${alt} (${src})` : src)],
    [/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)"],
    // `**bold**`, `__bold__`, `*em*`, `_em_`, `~~strike~~`
    [/\*\*([^*\n]+)\*\*/g, "$1"],
    [/__([^_\n]+)__/g, "$1"],
    [/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2"],
    [/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2"],
    [/~~([^~\n]+)~~/g, "$1"],
    // `code`
    [/`([^`\n]+)`/g, "$1"],
];

export function toWeChatText(markdown) {
    if (typeof markdown !== "string" || markdown.trim() === "") return "";
    let text = markdown.replace(/\r\n?/g, "\n");

    // Fenced blocks: keep the code, drop the fence lines (and the language tag).
    text = text.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_match, body) => body.replace(/\n+$/, ""));
    // An unterminated fence (a cut-off stream) still must not reach WeChat.
    text = text.replace(/^[ \t]*```[^\n]*\n?/gm, "");

    for (const [pattern, replacement] of INLINE_RULES) text = text.replace(pattern, replacement);

    text = text
        // ATX headings → bare text
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
        // Table separator rows carry no content
        .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, "")
        // Task list / bullet markers → a bullet WeChat reads cleanly
        .replace(/^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/gm, "$1• ")
        .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
        // Horizontal rules
        .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "———")
        // Blockquote markers
        .replace(/^[ \t]{0,3}>[ \t]?/gm, "");

    return text
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** One-line preview for logs and the status page. */
export function preview(text, limit = 60) {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** Short, stable label for an opaque WeChat id. */
export function shortId(id, keep = 6) {
    const value = typeof id === "string" ? id : "";
    if (value === "") return "?";
    return value.length <= keep ? value : `…${value.slice(-keep)}`;
}
