(https://github.com/user-attachments/files/26290849/README.md)
# AutoLeaveBlacklistVoice

A [Vencord](https://github.com/Vendicated/Vencord) / [Equicord](https://github.com/Equicord/Equicord) user plugin that automatically disconnects you from voice calls when a blacklisted user is present.

---

## Features

- **Blacklist by user ID** — add any number of Discord account IDs
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

| Setting | Type | Default | Description |
|---|---|---|---|
| `Blacklist IDs` | string | `""` | Space-separated Discord user IDs that trigger auto-leave |
| `Delay (ms)` | number | `0` | Milliseconds to wait before leaving (0 = instant, max 10000) |

### How to find a Discord user ID

1. Enable **Developer Mode** in Discord settings (`Settings → Advanced → Developer Mode`)
2. Right-click any user → **Copy User ID**

---

## How It Works

The plugin subscribes to Discord's internal `VOICE_STATE_UPDATES` Flux event and checks every voice state change against your blacklist.

**Auto-leave is triggered when:**
- You join a voice channel that already contains a blacklisted user
- A blacklisted user joins the voice channel you're currently in

**Auto-leave is cancelled when:**
- All blacklisted users leave the channel before the delay expires
- You manually disconnect from the call

When a delay is configured, a toast notification will appear counting down. If the condition is no longer met when the timer fires, no action is taken.

---

## Files

```
autoLeaveBlacklistVoice/
└── index.ts
```

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
