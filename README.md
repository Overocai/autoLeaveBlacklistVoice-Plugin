
# AutoLeaveBlacklistVoice

A [Vencord](https://github.com/Vendicated/Vencord) / [Equicord](https://github.com/Equicord/Equicord) user plugin that automatically disconnects you from voice calls when a blacklisted user — **or anyone with a blacklisted role** — is present.

---

## Preview

<p align="center">
  <img src="preview.png" alt="AutoLeaveBlacklistVoice settings panel" width="520">
</p>

---

## Features

- **Blacklist by user ID** — add any number of Discord account IDs
- **Blacklist by role ID** — auto-leave whenever a member with one of these roles is in the call
- **Polished settings UI** — manage everything from a custom panel with removable chips (resolved usernames/avatars and colored role tags), live validation, and a delay slider
- **Configurable delay** — set a delay (0–10,000 ms) before the auto-leave triggers
- **Covers all call types** — guild voice channels, DMs, and Group DMs
- **Smart detection** — triggers both when a blacklisted user joins your call *and* when you join a call they're already in
- **Auto-cancel** — if all blacklisted users leave before the delay ends, the pending leave is cancelled
- **Toast notifications** — get notified when auto-leave is triggered or cancelled

---

## Installation

> Requires Vencord or Equicord with user plugin support enabled.

1. Clone or download this repository
2. Copy the `autoLeaveBlacklistVoice/` folder into your client mod's user plugins directory:

```
# Vencord
src/userplugins/autoLeaveBlacklistVoice/

# Equicord
src/userplugins/autoLeaveBlacklistVoice/
```

3. Rebuild your client mod:

```bash
pnpm build
# or for dev mode
pnpm watch
```

4. Go to **Settings → Plugins** and enable **AutoLeaveBlacklistVoice**

---

## Configuration

Everything is managed from the plugin's custom settings panel:

| Setting | Description |
|---|---|
| **Blocked users** | Paste one or more user IDs (space- or comma-separated) and click **Add** (or press Enter). Added users show up as chips with their avatar and name. |
| **Blocked roles** | Paste one or more role IDs to leave whenever a member with that role is in the call. Chips show the role's name and color. |
| **Leave delay** | Slider (Instant → 10s) controlling how long to wait before leaving. |

> You can paste a whole list of IDs at once — invalid entries and duplicates are skipped automatically.

### How to find a user or role ID

1. Enable **Developer Mode** in Discord settings (`Settings → Advanced → Developer Mode`)
2. Right-click a **user** → **Copy User ID**, or a **role** (Server Settings → Roles) → **Copy Role ID**

> Note: role detection relies on the member being cached by Discord. For people already in your call this is normally the case, but in very large servers a not-yet-loaded member might be missed — blacklisting by user ID is always reliable.

---

## How It Works

The plugin subscribes to Discord's internal `VOICE_STATE_UPDATES` Flux event and checks every voice state change against your blacklist (by user ID **and** by role).

**Auto-leave is triggered when:**
- You join a voice channel that already contains a blacklisted user/role
- A blacklisted user/role joins the voice channel you're currently in

**Auto-leave is cancelled when:**
- All blacklisted members leave the channel before the delay expires
- You manually disconnect from the call

When a delay is configured, a toast notification will appear counting down. If the condition is no longer met when the timer fires, no action is taken.

---

## Files

```
autoLeaveBlacklistVoice/
├── index.tsx     # plugin logic + settings UI
└── styles.css    # settings panel styling
```

---

## Changelog

### 06/17/2026
- **New:** blacklist by **role ID** — auto-leave when any member with a blacklisted role is in the call
- **New:** redesigned **settings UI** with chip-based user/role management (resolved avatars, names, and role colors), input validation, and a delay slider
- **New:** the Add field now accepts **multiple IDs at once** (space-, comma- or newline-separated) — invalid entries and duplicates are skipped, restoring bulk-paste from the UI
- **Improved:** auto-leave now also re-checks when a blacklisted member moves to another channel
- **Optimized:** ID lookups now use `Set`-based matching (O(1)), blacklists are parsed once per event, and role resolution is memoized in the UI

---

## Requirements

- [Vencord](https://github.com/Vendicated/Vencord) or [Equicord](https://github.com/Equicord/Equicord)
- Node.js + pnpm (for building)

---

## License

GPL-3.0-or-later — same license as Vencord/Equicord.

---

## Author

**overocai** — `1288832011452153910`
