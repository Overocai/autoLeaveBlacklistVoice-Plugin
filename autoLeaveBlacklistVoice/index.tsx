/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { ErrorBoundary } from "@components/index";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildRoleStore, GuildStore, React, Slider, TextInput, Toasts, UserStore } from "@webpack/common";

const cl = classNameFactory("vc-albv-");

// Stores and actions loaded lazily
const VoiceStateStore = findByPropsLazy("getVoiceStateForUser", "getVoiceStatesForChannel");
const MediaEngineActions = findByPropsLazy("disconnect", "setChannel");

// Settings definition
const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <ErrorBoundary noop><SettingsPanel /></ErrorBoundary>,
    },
    blacklistIds: {
        type: OptionType.STRING,
        default: "",
        description: "User IDs (space-separated) that will trigger auto-leave",
        restartNeeded: false,
    },
    blacklistRoleIds: {
        type: OptionType.STRING,
        default: "",
        description: "Role IDs (space-separated) — auto-leave when any member with one of these roles is in the call",
        restartNeeded: false,
    },
    delayMs: {
        type: OptionType.NUMBER,
        default: 0,
        description: "Delay in milliseconds before leaving the call (0 = instant, max: 10000)",
        restartNeeded: false,
    }
}, {
    // The raw values are managed by the custom panel above, so hide the plain inputs.
    blacklistIds: { hidden() { return true; } },
    blacklistRoleIds: { hidden() { return true; } },
    delayMs: { hidden() { return true; } },
});

// Helper: parse a space-separated ID list (preserves order; used by the settings UI)
function parseList(raw: string): string[] {
    const trimmed = raw.trim();
    return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
}

// Helper: parse a space-separated, numeric-only ID list into a Set for O(1) lookups
function parseIdSet(raw: string): Set<string> {
    const set = new Set<string>();
    for (const id of raw.trim().split(/\s+/)) {
        if (/^\d+$/.test(id)) set.add(id);
    }
    return set;
}

// Helper: get current user's voice channel ID
function getCurrentVoiceChannelId(): string | null {
    try {
        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) return null;

        const voiceState = VoiceStateStore.getVoiceStateForUser(currentUser.id);
        return voiceState?.channelId ?? null;
    } catch {
        return null;
    }
}

// Helper: resolve the guild a voice channel belongs to
function getGuildIdForChannel(channelId: string): string | null {
    try {
        return ChannelStore.getChannel(channelId)?.guild_id ?? null;
    } catch {
        return null;
    }
}

// Helper: check if a member has any of the blacklisted roles
function userHasBlacklistedRole(guildId: string | null, userId: string, roleBlacklist: Set<string>): boolean {
    if (!guildId || roleBlacklist.size === 0) return false;

    try {
        const roles = GuildMemberStore.getMember(guildId, userId)?.roles;
        return roles ? roles.some((roleId: string) => roleBlacklist.has(roleId)) : false;
    } catch {
        return false;
    }
}

// Helper: check if a user matches the blacklist by ID or by role
function isUserBlacklisted(userId: string, guildId: string | null, users: Set<string>, roles: Set<string>): boolean {
    return users.has(userId) || userHasBlacklistedRole(guildId, userId, roles);
}

// Helper: check if any blacklisted user (by ID or role) is in a given channel.
// Accepts pre-parsed sets to avoid re-parsing settings in the hot event path.
function hasBlacklistedUserInChannel(
    channelId: string,
    users = parseIdSet(settings.store.blacklistIds),
    roles = parseIdSet(settings.store.blacklistRoleIds)
): boolean {
    if (users.size === 0 && roles.size === 0) return false;

    let states: Record<string, unknown>;
    try {
        states = VoiceStateStore.getVoiceStatesForChannel(channelId);
    } catch {
        return false;
    }
    if (!states) return false;

    const guildId = getGuildIdForChannel(channelId);

    return Object.keys(states).some(userId => isUserBlacklisted(userId, guildId, users, roles));
}

// Pending timers for cleanup
let pendingTimeout: ReturnType<typeof setTimeout> | null = null; // the scheduled leave
let recheckTimeout: ReturnType<typeof setTimeout> | null = null; // safety re-scan for late-loading member roles

// Helper: clear the safety re-scan timer
function clearRecheck() {
    if (recheckTimeout !== null) {
        clearTimeout(recheckTimeout);
        recheckTimeout = null;
    }
}

// Helper: cancel any pending auto-leave
function cancelPendingLeave(notify = false) {
    if (pendingTimeout !== null) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }

    if (notify) {
        Toasts.show({
            message: "AutoLeave cancelled: blacklisted user left the call",
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
            options: {
                duration: 2000,
                position: Toasts.Position.BOTTOM,
            }
        });
    }
}

// Helper: perform the actual disconnect
function performLeave(reason: string) {
    try {
        MediaEngineActions.disconnect();
    } catch {
        try {
            FluxDispatcher.dispatch({
                type: "VOICE_CHANNEL_SELECT",
                channelId: null,
                guildId: null,
            });
        } catch (e) {
            console.error("[AutoLeaveBlacklistVoice] Failed to disconnect:", e);
        }
    }

    Toasts.show({
        message: `AutoLeave: ${reason}`,
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: {
            duration: 3000,
            position: Toasts.Position.BOTTOM,
        }
    });
}

// Helper: schedule auto-leave with the configured delay.
// The leave always runs from a timer (even when the delay is 0) so we never
// disconnect in the middle of the Flux dispatch we're reacting to — doing that
// can throw "Cannot dispatch in the middle of a dispatch", which gets swallowed
// and leaves us stuck in the call.
function scheduleLeave(reason: string) {
    clearRecheck();
    if (pendingTimeout !== null) return; // a leave is already scheduled; let it run

    const delay = Math.min(Math.max(0, settings.store.delayMs || 0), 10000);

    if (delay > 0) {
        Toasts.show({
            message: `AutoLeave in ${delay}ms: ${reason}`,
            type: Toasts.Type.MESSAGE,
            id: Toasts.genId(),
            options: {
                duration: delay + 500,
                position: Toasts.Position.BOTTOM,
            }
        });
    }

    pendingTimeout = setTimeout(() => {
        pendingTimeout = null;

        // Re-check on fire: still in a call with a blacklisted user?
        const channelId = getCurrentVoiceChannelId();
        if (channelId && hasBlacklistedUserInChannel(channelId)) {
            performLeave(reason);
        } else if (delay > 0) {
            // They left before the timer fired — let the user know the leave was aborted.
            Toasts.show({
                message: "AutoLeave cancelled: blacklisted user is no longer in the call",
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId(),
                options: {
                    duration: 2000,
                    position: Toasts.Position.BOTTOM,
                }
            });
        }
    }, delay);
}

// Helper: schedule a one-shot re-scan. A member's roles may not be cached yet
// the instant they join, so a role-based match can be missed; this re-checks the
// channel shortly after and only acts if a blacklisted member is actually found.
function scheduleRecheck() {
    if (pendingTimeout !== null || recheckTimeout !== null) return;

    recheckTimeout = setTimeout(() => {
        recheckTimeout = null;
        const channelId = getCurrentVoiceChannelId();
        if (channelId && hasBlacklistedUserInChannel(channelId)) {
            scheduleLeave("Blacklisted member detected");
        }
    }, 2500);
}

// Flux event handler for VOICE_STATE_UPDATES
function handleVoiceStateUpdate({ voiceStates }: {
    voiceStates: Array<{
        userId: string;
        channelId: string | null;
        oldChannelId?: string | null;
        guildId?: string | null;
    }>;
}) {
    try {
        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) return;

        const users = parseIdSet(settings.store.blacklistIds);
        const roles = parseIdSet(settings.store.blacklistRoleIds);
        if (users.size === 0 && roles.size === 0) return;

        // Determine our current channel. Prefer our own state from this batch
        // (freshest), falling back to the store for events about other users.
        const ourState = voiceStates.find(s => s.userId === currentUser.id);
        const ourChannelId = ourState ? ourState.channelId : getCurrentVoiceChannelId();

        // Not in a call -> nothing to do; drop any pending leave/re-scan.
        if (!ourChannelId) {
            cancelPendingLeave();
            clearRecheck();
            return;
        }

        // Only react if this batch actually involves us or our channel.
        const relevant = voiceStates.some(s =>
            s.userId === currentUser.id ||
            s.channelId === ourChannelId ||
            s.oldChannelId === ourChannelId
        );
        if (!relevant) return;

        // Authoritative check: is anyone blacklisted (by ID or role) in our channel right now?
        if (hasBlacklistedUserInChannel(ourChannelId, users, roles)) {
            // Someone blacklisted is here — schedule the leave (no-op if already scheduled).
            scheduleLeave("Blacklisted user in the call");
        } else if (pendingTimeout === null && roles.size > 0) {
            // Nobody matched right now. A member who just joined may not have their roles
            // cached yet, so re-scan shortly. We deliberately do NOT cancel an
            // already-scheduled leave on a negative check: the scheduled leave re-checks
            // before disconnecting, so a transient miss (e.g. uncached roles) can't abort
            // a valid leave — that bug left users stuck in the call.
            scheduleRecheck();
        }
    } catch (e) {
        console.error("[AutoLeaveBlacklistVoice] Error in voice state handler:", e);
    }
}

// ────────────────────────────── Settings UI ──────────────────────────────

// Resolve a role's name + color by scanning the guilds we're in
function resolveRole(roleId: string): { name: string; color: number; } | null {
    try {
        const guilds = GuildStore.getGuilds();
        for (const gid in guilds) {
            const role = GuildRoleStore.getRole(gid, roleId);
            if (role) return { name: role.name, color: role.color };
        }
    } catch { /* ignore */ }
    return null;
}

function intToHex(color: number): string | null {
    if (!color) return null;
    return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}

function RemoveButton({ onClick }: { onClick: () => void; }) {
    return (
        <button className={cl("chip-remove")} onClick={onClick} aria-label="Remove">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
        </button>
    );
}

function UserChip({ id, onRemove }: { id: string; onRemove: () => void; }) {
    const user = UserStore.getUser(id);
    const name = user?.username ?? id;
    const avatarUrl = user?.getAvatarURL?.(undefined, 32) ?? null;

    return (
        <div className={cl("chip")} title={id}>
            {avatarUrl
                ? <img className={cl("chip-avatar")} src={avatarUrl} alt="" />
                : <span className={cl("chip-avatar", "chip-avatar-fallback")}>{(name[0] ?? "?").toUpperCase()}</span>}
            <span className={cl("chip-label")}>{name}</span>
            <RemoveButton onClick={onRemove} />
        </div>
    );
}

function RoleChip({ id, onRemove }: { id: string; onRemove: () => void; }) {
    const role = React.useMemo(() => resolveRole(id), [id]);
    const color = (role && intToHex(role.color)) || "var(--brand-500, #5865f2)";

    return (
        <div className={cl("chip", "chip-role")} title={id}>
            <span className={cl("chip-dot")} style={{ background: color }} />
            <span className={cl("chip-label")}>{role?.name ?? id}</span>
            <RemoveButton onClick={onRemove} />
        </div>
    );
}

const SECTION_CONFIG = {
    users: {
        key: "blacklistIds" as const,
        title: "Blocked users",
        desc: "You'll automatically leave any call these users are in.",
        placeholder: "Paste user ID(s) — space or comma separated…",
        empty: "No blocked users yet.",
    },
    roles: {
        key: "blacklistRoleIds" as const,
        title: "Blocked roles",
        desc: "Leave whenever a member with any of these roles is in the call.",
        placeholder: "Paste role ID(s) — space or comma separated…",
        empty: "No blocked roles yet.",
    },
};

// Format a delay value (ms) as a short label
function formatDelay(ms: number, instant = false): string {
    if (ms < 500) return instant ? "Instant" : "0s";
    return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

function ListSection({ kind }: { kind: "users" | "roles"; }) {
    const config = SECTION_CONFIG[kind];
    const store = settings.use([config.key]);
    const raw = (store[config.key] as string) ?? "";
    const list = parseList(raw);

    const [input, setInput] = React.useState("");
    const [error, setError] = React.useState<string | null>(null);

    function commit() {
        // Accept one or many IDs at once — split on whitespace, commas or newlines
        const tokens = input.split(/[\s,]+/).filter(Boolean);
        if (tokens.length === 0) return;

        const existing = new Set(list);
        const toAdd: string[] = [];
        let invalid = 0;

        for (const token of tokens) {
            if (!/^\d{5,}$/.test(token)) { invalid++; continue; }
            if (existing.has(token) || toAdd.includes(token)) continue; // skip duplicates
            toAdd.push(token);
        }

        if (toAdd.length > 0) {
            settings.store[config.key] = [...list, ...toAdd].join(" ");
            setInput("");
            setError(invalid > 0 ? `Added ${toAdd.length}, ignored ${invalid} invalid entr${invalid > 1 ? "ies" : "y"}.` : null);
            return;
        }

        // Nothing added — explain why (keep the input so it can be fixed)
        setError(invalid > 0
            ? "That doesn't look like a valid ID (numbers only)."
            : "Those IDs are already in the list.");
    }

    function remove(id: string) {
        settings.store[config.key] = list.filter(x => x !== id).join(" ");
    }

    return (
        <Card className={cl("section")}>
            <div className={cl("section-header")}>
                <span className={cl("section-title")}>{config.title}</span>
                <span className={cl("count")}>{list.length}</span>
            </div>
            <p className={cl("section-desc")}>{config.desc}</p>

            <div className={cl("input-row")}>
                <TextInput
                    type="text"
                    value={input}
                    placeholder={config.placeholder}
                    onChange={(v: string) => { setInput(v); setError(null); }}
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") commit(); }}
                    maxLength={null}
                />
                <Button
                    variant="primary"
                    size="medium"
                    className={cl("add-btn")}
                    onClick={commit}
                    disabled={!input.trim()}
                >
                    Add
                </Button>
            </div>

            {error && <span className={cl("error")}>{error}</span>}

            <div className={cl("chips")}>
                {list.length === 0
                    ? <span className={cl("empty")}>{config.empty}</span>
                    : list.map(id => kind === "users"
                        ? <UserChip key={id} id={id} onRemove={() => remove(id)} />
                        : <RoleChip key={id} id={id} onRemove={() => remove(id)} />)}
            </div>
        </Card>
    );
}

function DelaySection() {
    const store = settings.use(["delayMs"]);

    return (
        <Card className={cl("section")}>
            <div className={cl("section-header")}>
                <span className={cl("section-title")}>Leave delay</span>
            </div>
            <p className={cl("section-desc")}>
                Wait this long before leaving. If everyone blocked leaves first, the auto-leave is cancelled.
            </p>
            <div className={cl("slider-wrap")}>
                <Slider
                    markers={[0, 1000, 2000, 3000, 5000, 7500, 10000]}
                    initialValue={store.delayMs ?? 0}
                    minValue={0}
                    maxValue={10000}
                    onValueChange={(v: number) => settings.store.delayMs = Math.round(v)}
                    onMarkerRender={(v: number) => formatDelay(v)}
                    onValueRender={(v: number) => formatDelay(v, true)}
                    stickToMarkers
                />
            </div>
        </Card>
    );
}

function SettingsPanel() {
    return (
        <div className={cl("container")}>
            <ListSection kind="users" />
            <ListSection kind="roles" />
            <DelaySection />

            <p className={cl("hint")}>
                Tip: enable <strong>Developer Mode</strong> (Settings → Advanced), then right-click a
                user or a role to <strong>Copy ID</strong>.
            </p>
        </div>
    );
}

export default definePlugin({
    name: "AutoLeaveBlacklistVoice",
    description: "Automatically leaves voice calls when a blacklisted user (by ID or role) joins or is already present",
    authors: [{ name: "overocai", id: 1288832011452153910n }],
    settings,

    start() {
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", handleVoiceStateUpdate);
    },

    stop() {
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", handleVoiceStateUpdate);
        cancelPendingLeave();
        clearRecheck();
    }
});
