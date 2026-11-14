/**
 * Per-session composition applied to every WeChat-bound session.
 *
 * A fresh `agents.create` produces a bare Agent: no preset tools or prompt
 * sections, and (on hosts that record a durable selection) no provider/model,
 * which makes the first step fail before any waterfall runs. The GUI's own
 * compose path does all of this; a channel plugin has to do the same three
 * things itself:
 *
 *   1. mount the session's Agent Preset (its tools and prompt sections),
 *   2. make sure the session has a route it can start on,
 *   3. publish the live selection as prompt variables so `{{model}}` matches.
 *
 * Adapted from dsh-wechat's `agentSetup` (MIT), which is verified against the
 * DSH 0.2.1 and 0.2.2+ service surfaces.
 */

/** Fold the host `modelSelection` projection value into a selection. */
export function modelSelectionFromProjection(value) {
    if (!value || typeof value !== "object") return undefined;
    const pick = (candidate) => {
        if (!candidate || typeof candidate !== "object") return undefined;
        if (typeof candidate.provider !== "string" || typeof candidate.model !== "string") return undefined;
        return {
            provider: candidate.provider,
            model: candidate.model,
            ...(typeof candidate.reasoningEffort === "string" ? { reasoningEffort: candidate.reasoningEffort } : {}),
        };
    };
    return pick(value.next) ?? pick(value.lastUsed);
}

function liveAgent(agentCtx, agent) {
    return agent ?? agentCtx?.agent;
}

/**
 * Give a session with no route a durable model selection.
 *
 * DSH 0.2.2+ stops a step before any waterfall when the Agent has no
 * provider/model, so a channel-created session must record one up front. The
 * cascade keeps an existing route, then the resumed session's last request
 * header, then the deployment default the GUI's new-session path uses.
 */
function seedModelSelection(ctx, agent) {
    const model = agent?.model;
    if (!model || typeof model.current !== "function" || typeof model.select !== "function") return;
    try {
        if (model.current() !== undefined) return;
        const logged = agent?.session?.requestHeader?.()?.config;
        const candidate = logged?.provider && logged.model
            ? { provider: logged.provider, model: logged.model, ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}) }
            : ctx.get?.("agentDefaultModel")?.currentSelection();
        if (!candidate?.provider || !candidate.model) return;
        model.select(candidate);
    }
    catch (error) {
        console.error(`[wechat-groupchat] seeding the model selection failed: ${String(error)}`);
    }
}

export async function agentSetup(agentCtx, agent) {
    const ctx = agentCtx;
    const live = liveAgent(agentCtx, agent);

    // Preset mount: the session's recorded preset decides its tools and prompt.
    const presets = ctx.get?.("agentPresets");
    if (presets) {
        try {
            await presets.mount(agentCtx, live?.session?.header?.agentPreset);
        }
        catch (error) {
            console.error(`[wechat-groupchat] mounting the agent preset failed: ${String(error)}`);
        }
    }

    const controller = ctx.get?.("sessionController");
    const hostOwnsSelection = typeof controller?.selectModel === "function";
    const modelAccessor = live?.model;
    const hostRecordsSelection = typeof modelAccessor?.select === "function";
    if (hostRecordsSelection) seedModelSelection(ctx, live);

    const currentSelection = () => {
        const session = live?.session;
        const projections = ctx.get?.("sessionProjections");
        if (session && projections) {
            try {
                const projected = modelSelectionFromProjection(projections.snapshot(session)?.values?.modelSelection);
                if (projected?.provider && projected.model) return projected;
            }
            catch {
                // No projection for this session yet; fall through to the log.
            }
        }
        const logged = session?.requestHeader?.()?.config;
        if (logged?.provider && logged.model) {
            return {
                provider: logged.provider,
                model: logged.model,
                ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
            };
        }
        return ctx.get?.("agentDefaultModel")?.currentSelection();
    };

    // Older host line (no durable selection accessor): its emptiness check runs
    // AFTER the request waterfall, so the route has to be filled in there.
    if (!hostOwnsSelection && !hostRecordsSelection) {
        const selected = currentSelection();
        if (!selected?.provider || !selected.model) return;
        ctx.on?.("system-prompt/assemble", async (_assembly, _context, next) => {
            const assembled = await next();
            return {
                ...assembled,
                variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
            };
        });
        ctx.on?.("agent/request", async (_payload, next) => {
            const resolved = await next();
            return {
                ...resolved,
                provider: selected.provider,
                model: selected.model,
                ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
            };
        });
        return;
    }

    // The prompt follows the live selection on every host line.
    let assembledSelection;
    ctx.on?.("system-prompt/assemble", async (_assembly, _context, next) => {
        const selected = currentSelection();
        const assembled = await next();
        if (!hostRecordsSelection) assembledSelection = selected;
        if (!selected?.provider || !selected.model) return assembled;
        return {
            ...assembled,
            variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
        };
    });

    if (!hostRecordsSelection) {
        ctx.on?.("agent/request", async (_payload, next) => {
            const resolved = await next();
            const selected = assembledSelection ?? currentSelection();
            if (!selected?.provider || !selected.model) return resolved;
            const { reasoningEffort: _inherited, ...rest } = resolved;
            return {
                ...rest,
                provider: selected.provider,
                model: selected.model,
                ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
            };
        });
    }
}
