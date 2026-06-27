/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { ErrorBoundary } from "@components/index";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelActions, ChannelStore, FluxDispatcher, GuildMemberStore, GuildRoleStore, GuildStore, React, SelectedChannelStore, Slider, TextInput, Toasts, UserStore } from "@webpack/common";

const cl = classNameFactory("vc-albv-");

// Stores and actions loaded lazily
const VoiceStateStore = findByPropsLazy("getVoiceStateForUser", "getVoiceStatesForChannel");
const MediaEngineActions = findByPropsLazy("disconnect", "setChannel");
const GuildActions = findByPropsLazy("requestMembersById", "banUser");

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
    },
    activityLog: {
        type: OptionType.STRING,
        default: "",
        description: "internal: recent auto-leave activity",
        restartNeeded: false,
    }
}, {
    // The raw values are managed by the custom panel above, so hide the plain inputs.
    blacklistIds: { hidden() { return true; } },
    blacklistRoleIds: { hidden() { return true; } },
    delayMs: { hidden() { return true; } },
    activityLog: { hidden() { return true; } },
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

// Helper: get the voice channel this client is currently connected to
function getCurrentVoiceChannelId(): string | null {
    try {
        return SelectedChannelStore.getVoiceChannelId() ?? null;
    } catch {
        // Fallback for builds where SelectedChannelStore isn't ready yet.
        try {
            const currentUser = UserStore.getCurrentUser();
            return currentUser ? VoiceStateStore.getVoiceStateForUser(currentUser.id)?.channelId ?? null : null;
        } catch {
            return null;
        }
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
    const selfId = UserStore.getCurrentUser()?.id;

    // Never count ourselves — blacklisting your own ID/role shouldn't auto-leave you.
    return Object.keys(states).some(userId =>
        userId !== selfId && isUserBlacklisted(userId, guildId, users, roles)
    );
}

// ── Activity log ──────────────────────────────────────────
interface LogEntry { ids: string[]; names: string[]; channel: string | null; time: number; }

const MAX_LOG = 25;

// Resolve a user's display name (falls back to the raw ID if not cached)
function displayName(id: string): string {
    try { return UserStore.getUser(id)?.username ?? id; }
    catch { return id; }
}

// Find the blacklisted members currently in a channel (returns their user IDs)
function findBlacklistedMembers(channelId: string): string[] {
    const users = parseIdSet(settings.store.blacklistIds);
    const roles = parseIdSet(settings.store.blacklistRoleIds);
    if (users.size === 0 && roles.size === 0) return [];

    let states: Record<string, unknown>;
    try { states = VoiceStateStore.getVoiceStatesForChannel(channelId); }
    catch { return []; }
    if (!states) return [];

    const guildId = getGuildIdForChannel(channelId);
    const selfId = UserStore.getCurrentUser()?.id;
    return Object.keys(states).filter(uid => uid !== selfId && isUserBlacklisted(uid, guildId, users, roles));
}

function readLog(): LogEntry[] {
    try {
        const parsed = JSON.parse(settings.store.activityLog || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Record an auto-leave (who was in the call), keeping only the most recent entries
function logTrigger(channelId: string, ids: string[]) {
    if (ids.length === 0) return;

    let channel: string | null = null;
    try { channel = ChannelStore.getChannel(channelId)?.name ?? null; }
    catch { /* ignore */ }

    const entry: LogEntry = { ids, names: ids.map(displayName), channel, time: Date.now() };
    settings.store.activityLog = JSON.stringify([entry, ...readLog()].slice(0, MAX_LOG));
}

// Human-friendly relative time
function timeAgo(ts: number): string {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// How often to re-scan the channel while connected. This is the safety net for
// voice events that never fire and for member roles that load after someone joins.
const POLL_INTERVAL_MS = 3000;

// Timers for cleanup
let pendingTimeout: ReturnType<typeof setTimeout> | null = null; // the scheduled leave
let pollInterval: ReturnType<typeof setInterval> | null = null; // periodic channel re-scan while in a call

// Helper: stop the periodic re-scan
function stopPolling() {
    if (pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
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

// Helper: perform the actual disconnect. Always runs from a timer (see
// scheduleLeave) so it can safely dispatch without colliding with the Flux
// dispatch we're reacting to.
function performLeave(reason: string) {
    // Capture who triggered this *before* we disconnect and drop out of the channel.
    const channelId = getCurrentVoiceChannelId();
    const triggers = channelId ? findBlacklistedMembers(channelId) : [];

    let left = false;

    // Primary: the canonical "leave voice channel" action.
    try {
        ChannelActions.selectVoiceChannel(null);
        left = true;
    } catch (primaryErr) {
        // Fallbacks for client builds where the action shape differs.
        try {
            MediaEngineActions.disconnect();
            left = true;
        } catch {
            try {
                FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: null, guildId: null });
                left = true;
            } catch (fallbackErr) {
                console.error("[AutoLeaveBlacklistVoice] Failed to disconnect:", primaryErr, fallbackErr);
            }
        }
    }

    if (!left) return;

    if (channelId && triggers.length) logTrigger(channelId, triggers);

    const who = triggers.map(displayName).join(", ");
    Toasts.show({
        message: who ? `AutoLeave: left because of ${who}` : `AutoLeave: ${reason}`,
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

// Request guild members whose data isn't cached yet so their roles populate the
// GuildMemberStore for the next scan. Without this, a role-based match can be
// permanently missed in large servers where members aren't loaded automatically.
function requestUncachedMembers(channelId: string, guildId: string | null) {
    if (!guildId) return;

    try {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        if (!states) return;

        const selfId = UserStore.getCurrentUser()?.id;
        const missing = Object.keys(states).filter(uid => uid !== selfId && !GuildMemberStore.getMember(guildId, uid));
        if (missing.length) GuildActions.requestMembersById(guildId, missing, false);
    } catch { /* ignore */ }
}

// Single decision point: leave if a blacklisted member is present, otherwise make
// sure any uncached members get fetched so the next scan can see their roles.
function evaluateChannel(channelId: string, users: Set<string>, roles: Set<string>) {
    if (hasBlacklistedUserInChannel(channelId, users, roles)) {
        scheduleLeave("Blacklisted user in the call");
    } else if (roles.size > 0) {
        requestUncachedMembers(channelId, getGuildIdForChannel(channelId));
    }
}

// Start the periodic re-scan (no-op if already running). The safety net: it catches
// blacklisted members even when no voice event fires for them and even when their
// roles only load seconds after they join.
function startPolling() {
    if (pollInterval !== null) return;

    pollInterval = setInterval(() => {
        try {
            const channelId = getCurrentVoiceChannelId();
            if (!channelId) { stopPolling(); return; }

            const users = parseIdSet(settings.store.blacklistIds);
            const roles = parseIdSet(settings.store.blacklistRoleIds);
            if (users.size === 0 && roles.size === 0) { stopPolling(); return; }

            evaluateChannel(channelId, users, roles);
        } catch (e) {
            console.error("[AutoLeaveBlacklistVoice] Poll error:", e);
        }
    }, POLL_INTERVAL_MS);
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
        if (!Array.isArray(voiceStates)) return;

        const currentUser = UserStore.getCurrentUser();
        if (!currentUser) return;

        const users = parseIdSet(settings.store.blacklistIds);
        const roles = parseIdSet(settings.store.blacklistRoleIds);
        if (users.size === 0 && roles.size === 0) { stopPolling(); return; }

        // Determine our current channel. Prefer our own state from this batch
        // (freshest), falling back to the store for events about other users.
        const ourState = voiceStates.find(s => s.userId === currentUser.id);
        const ourChannelId = ourState ? ourState.channelId : getCurrentVoiceChannelId();

        // Not in a call -> nothing to do; drop any pending leave and stop polling.
        if (!ourChannelId) {
            cancelPendingLeave();
            stopPolling();
            return;
        }

        // We're in a call with blacklists configured — keep the safety poll running.
        startPolling();

        // Only react immediately if this batch actually involves us or our channel.
        const relevant = voiceStates.some(s =>
            s.userId === currentUser.id ||
            s.channelId === ourChannelId ||
            s.oldChannelId === ourChannelId
        );
        if (!relevant) return;

        // Leave if a blacklisted member is present; otherwise fetch uncached members
        // so the next scan/poll can see their roles. We never cancel an already
        // scheduled leave here — the leave re-checks before disconnecting, so a
        // transient miss (e.g. uncached roles) can't abort a valid leave.
        evaluateChannel(ourChannelId, users, roles);
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
        noun: "user",
        placeholder: "Paste user ID(s) — space or comma separated…",
        empty: "No blocked users yet. Paste an ID above to get started.",
    },
    roles: {
        key: "blacklistRoleIds" as const,
        noun: "role",
        placeholder: "Paste role ID(s) — space or comma separated…",
        empty: "No blocked roles yet. Paste a role ID above to get started.",
    },
};

type Kind = keyof typeof SECTION_CONFIG;

const DELAY_PRESETS = [0, 1000, 2000, 3000, 5000, 10000];

// Format a delay value (ms) as a short label
function formatDelay(ms: number, instant = false): string {
    if (ms < 500) return instant ? "Instant" : "0s";
    return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

// ── Users / Roles tab switch ──
function Tabs({ tab, setTab, userCount, roleCount }: {
    tab: Kind; setTab: (k: Kind) => void; userCount: number; roleCount: number;
}) {
    const tabBtn = (k: Kind, label: string, count: number) => (
        <button className={cl("tab", tab === k && "tab-on")} onClick={() => setTab(k)}>
            <span>{label}</span>
            <span className={cl("tab-count")}>{count}</span>
        </button>
    );

    return (
        <div className={cl("tabs")}>
            {tabBtn("users", "Users", userCount)}
            {tabBtn("roles", "Roles", roleCount)}
        </div>
    );
}

// ── Add box + chip list for the active tab ──
function ListManager({ kind }: { kind: Kind; }) {
    const config = SECTION_CONFIG[kind];
    const store = settings.use([config.key]);
    const list = parseList((store[config.key] as string) ?? "");

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

        setError(invalid > 0
            ? "That doesn't look like a valid ID (numbers only)."
            : "Those IDs are already in the list.");
    }

    function remove(id: string) {
        settings.store[config.key] = list.filter(x => x !== id).join(" ");
    }

    function clearAll() {
        settings.store[config.key] = "";
        setError(null);
    }

    return (
        <div className={cl("manager")}>
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

            <div className={cl("list-head")}>
                <span className={cl("list-count")}>
                    {list.length} {config.noun}{list.length === 1 ? "" : "s"} blocked
                </span>
                {list.length > 0 && (
                    <button className={cl("clear-btn")} onClick={clearAll}>Clear all</button>
                )}
            </div>

            <div className={cl("chips")}>
                {list.length === 0
                    ? <div className={cl("empty")}>{config.empty}</div>
                    : list.map(id => kind === "users"
                        ? <UserChip key={id} id={id} onRemove={() => remove(id)} />
                        : <RoleChip key={id} id={id} onRemove={() => remove(id)} />)}
            </div>
        </div>
    );
}

// ── Delay control: slider + quick presets (kept in sync) ──
function DelayCard() {
    const store = settings.use(["delayMs"]);
    const value = store.delayMs ?? 0;

    // Bump this to force the slider to re-mount when a preset sets a new value
    // (the slider only reads initialValue on mount). Dragging never bumps it,
    // so live dragging stays smooth.
    const [presetVersion, setPresetVersion] = React.useState(0);

    function setDelay(ms: number) {
        settings.store.delayMs = ms;
        setPresetVersion(v => v + 1);
    }

    return (
        <div className={cl("card")}>
            <div className={cl("card-head")}>
                <span className={cl("card-title")}>Leave delay</span>
                <span className={cl("badge")}>{formatDelay(value, true)}</span>
            </div>
            <p className={cl("card-desc")}>
                Wait before leaving. If everyone blocked leaves first, the auto-leave is cancelled.
            </p>

            <div className={cl("slider-wrap")}>
                <Slider
                    key={presetVersion}
                    markers={[0, 1000, 2000, 3000, 5000, 7500, 10000]}
                    initialValue={value}
                    minValue={0}
                    maxValue={10000}
                    onValueChange={(v: number) => settings.store.delayMs = Math.round(v)}
                    onMarkerRender={(v: number) => formatDelay(v)}
                    onValueRender={(v: number) => formatDelay(v, true)}
                    stickToMarkers
                />
            </div>

            <div className={cl("presets")}>
                {DELAY_PRESETS.map(ms => (
                    <button
                        key={ms}
                        className={cl("preset", value === ms && "preset-on")}
                        onClick={() => setDelay(ms)}
                    >
                        {formatDelay(ms, true)}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ── Recent activity log (who was in the call when we auto-left) ──
function ActivityLog() {
    const store = settings.use(["activityLog"]);
    const log = React.useMemo<LogEntry[]>(() => {
        try {
            const parsed = JSON.parse(store.activityLog || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }, [store.activityLog]);

    return (
        <div className={cl("card")}>
            <div className={cl("card-head")}>
                <span className={cl("card-title")}>Recent activity</span>
                {log.length > 0 && (
                    <button className={cl("clear-btn")} onClick={() => settings.store.activityLog = ""}>Clear</button>
                )}
            </div>

            {log.length === 0
                ? <div className={cl("empty")}>No auto-leaves logged yet.</div>
                : (
                    <div className={cl("log")}>
                        {log.map((e, i) => (
                            <div className={cl("log-row")} key={`${e.time}-${i}`}>
                                <span className={cl("log-dot")} />
                                <span className={cl("log-text")}>
                                    Left {e.channel ? <strong>{e.channel}</strong> : "a call"} — {e.names.join(", ")}
                                </span>
                                <span className={cl("log-time")}>{timeAgo(e.time)}</span>
                            </div>
                        ))}
                    </div>
                )}
        </div>
    );
}

function SettingsPanel() {
    const [tab, setTab] = React.useState<Kind>("users");
    const store = settings.use(["blacklistIds", "blacklistRoleIds"]);
    const userCount = parseList(store.blacklistIds ?? "").length;
    const roleCount = parseList(store.blacklistRoleIds ?? "").length;

    return (
        <div className={cl("panel")}>
            <Tabs tab={tab} setTab={setTab} userCount={userCount} roleCount={roleCount} />
            <ListManager key={tab} kind={tab} />
            <DelayCard />
            <ActivityLog />

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

        // If we're enabled while already in a call, start the safety poll and act now.
        try {
            const channelId = getCurrentVoiceChannelId();
            if (!channelId) return;

            const users = parseIdSet(settings.store.blacklistIds);
            const roles = parseIdSet(settings.store.blacklistRoleIds);
            if (users.size === 0 && roles.size === 0) return;

            startPolling();
            evaluateChannel(channelId, users, roles);
        } catch (e) {
            console.error("[AutoLeaveBlacklistVoice] Error during start check:", e);
        }
    },

    stop() {
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", handleVoiceStateUpdate);
        cancelPendingLeave();
        stopPolling();
    }
});
