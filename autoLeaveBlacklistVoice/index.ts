/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Toasts } from "@webpack/common";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

// Stores and actions loaded lazily
const VoiceStateStore = findByPropsLazy("getVoiceStateForUser", "getVoiceStatesForChannel");
const MediaEngineActions = findByPropsLazy("disconnect", "setChannel");

// Settings definition
const settings = definePluginSettings({
    blacklistIds: {
        type: OptionType.STRING,
        default: "",
        description: "User IDs (space-separated) that will trigger auto-leave",
        restartNeeded: false,
    },
    delayMs: {
        type: OptionType.NUMBER,
        default: 0,
        description: "Delay in milliseconds before leaving the call (0 = instant, max: 10000)",
        restartNeeded: false,
    }
});

// Helper: parse blacklist IDs from settings string
function getBlacklistIds(): bigint[] {
    const raw = settings.store.blacklistIds.trim();
    if (!raw) return [];

    return raw
        .split(/\s+/)
        .filter(id => /^\d+$/.test(id))
        .map(id => {
            try { return BigInt(id); }
            catch { return null; }
        })
        .filter((id): id is bigint => id !== null);
}

// Helper: get current user's voice channel ID
function getCurrentVoiceChannelId(): string | null {
    try {
        const currentUser = (window as any).Vencord?.Webpack?.Common?.UserStore?.getCurrentUser?.();
        if (!currentUser) return null;

        const voiceState = VoiceStateStore.getVoiceStateForUser(currentUser.id);
        return voiceState?.channelId ?? null;
    } catch {
        return null;
    }
}

// Helper: get all user IDs in a voice channel
function getUserIdsInChannel(channelId: string): bigint[] {
    try {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
        if (!states) return [];

        return Object.keys(states).map(id => {
            try { return BigInt(id); }
            catch { return null; }
        }).filter((id): id is bigint => id !== null);
    } catch {
        return [];
    }
}

// Helper: check if any blacklisted user is in a given channel
function hasBlacklistedUserInChannel(channelId: string): boolean {
    const blacklist = getBlacklistIds();
    if (blacklist.length === 0) return false;

    const usersInChannel = getUserIdsInChannel(channelId);
    return usersInChannel.some(userId => blacklist.some(bid => bid === userId));
}

// Pending timeout reference for cleanup
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
let isLeaving = false;

// Helper: cancel any pending auto-leave
function cancelPendingLeave(notify = false) {
    if (pendingTimeout !== null) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }
    isLeaving = false;

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
    isLeaving = true;

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

    isLeaving = false;
}

// Helper: schedule auto-leave with configured delay
function scheduleLeave(reason: string) {
    cancelPendingLeave();

    const delay = Math.min(Math.max(0, settings.store.delayMs || 0), 10000);

    if (delay === 0) {
        performLeave(reason);
        return;
    }

    Toasts.show({
        message: `AutoLeave in ${delay}ms: ${reason}`,
        type: Toasts.Type.MESSAGE,
        id: Toasts.genId(),
        options: {
            duration: delay + 500,
            position: Toasts.Position.BOTTOM,
        }
    });

    pendingTimeout = setTimeout(() => {
        pendingTimeout = null;

        // Re-check: still in a call with a blacklisted user?
        const channelId = getCurrentVoiceChannelId();
        if (!channelId) return;

        if (hasBlacklistedUserInChannel(channelId)) {
            performLeave(reason);
        }
    }, delay);
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
        const currentUser = (window as any).Vencord?.Webpack?.Common?.UserStore?.getCurrentUser?.();
        if (!currentUser) return;

        const currentUserId = currentUser.id;
        const blacklist = getBlacklistIds();
        if (blacklist.length === 0) return;

        for (const state of voiceStates) {
            const { userId, channelId, oldChannelId } = state;

            // Case 1: WE joined a new voice channel
            if (userId === currentUserId && channelId && channelId !== oldChannelId) {
                if (hasBlacklistedUserInChannel(channelId)) {
                    scheduleLeave("Blacklisted user already in the call");
                } else {
                    cancelPendingLeave();
                }
                return;
            }

            // Case 2: WE left a voice channel
            if (userId === currentUserId && !channelId) {
                cancelPendingLeave();
                return;
            }

            // Case 3: A blacklisted user changed voice state
            const userIdBigInt = (() => {
                try { return BigInt(userId); }
                catch { return null; }
            })();

            if (!userIdBigInt) continue;

            const isBlacklisted = blacklist.some(bid => bid === userIdBigInt);
            if (!isBlacklisted) continue;

            const ourChannelId = getCurrentVoiceChannelId();
            if (!ourChannelId) continue; // We are not in a call

            if (channelId === ourChannelId) {
                // Blacklisted user joined our channel
                scheduleLeave(`Blacklisted user (${userId}) joined the call`);
            } else if (oldChannelId === ourChannelId && !channelId) {
                // Blacklisted user left our channel — cancel if no others remain
                if (!hasBlacklistedUserInChannel(ourChannelId)) {
                    cancelPendingLeave(true);
                }
            }
        }
    } catch (e) {
        console.error("[AutoLeaveBlacklistVoice] Error in voice state handler:", e);
    }
}

export default definePlugin({
    name: "AutoLeaveBlacklistVoice",
    description: "Automatically leaves voice calls when a blacklisted user joins or is already present",
    authors: [{ name: "overocai", id: 1288832011452153910n }],
    settings,

    start() {
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", handleVoiceStateUpdate);
    },

    stop() {
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", handleVoiceStateUpdate);
        cancelPendingLeave();
    }
});