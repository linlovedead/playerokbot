# 🎮 Playerok Auto-Helper

> [🇷🇺 Русский](README.md) | 🇬🇧 English

A free Chrome extension (Manifest V3) that automates game account sales on [playerok.com](https://playerok.com).

Auto-delivery of 2FA codes via SteamPass, automatic listing bumps, bulk item publishing, card/cover generator — all in one.

**Author:** [@dehughuglight](https://t.me/dehughuglight) (Telegram) · leeds.eha@gmail.com
**For any questions, suggestions or commercial licensing — please DM me on Telegram.**

---

## ✨ Features

| Module | What it does |
|--------|--------------|
| ⚡ **Auto-Fulfill** | Scans new orders, automatically sends greeting, login/password and 2FA code to the buyer |
| 🚀 **Auto-Bump** | Bumps your listings after cooldown expires (7 days), hidden window, randomized delays |
| 📝 **Auto-Publisher** | Bulk-publishes items from SteamPass to your Playerok profile |
| 🖼️ **Card Generator** | Preview card generator for listings (canvas rendering) |
| 📋 **Order History** | Local database of all delivered accounts with search |
| 📊 **Dashboard** | Real-time KPI: deliveries / bumps / queue |

---

## 🛠 Installation

### Option 1 — from source (recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/linlovedead/playerokbot.git
   ```
2. Open `chrome://extensions/` in your browser
3. Enable **"Developer mode"** (top-right corner)
4. Click **"Load unpacked"** → select the repository folder
5. Pin the icon to your toolbar

### Option 2 — build a ZIP

```powershell
.\build.ps1
```

Creates `playerok-bot-release.zip` in the project root — can be distributed or installed as an archive.

---

## 🚀 Quick Start

1. Log in to [playerok.com](https://playerok.com) and [steampass.gg](https://steampass.gg) in regular tabs
2. Open the extension (toolbar icon or side panel)
3. Go to **"Auto-Fulfill"** → enter your Playerok username → **START**
4. The bot will scan orders and send codes automatically

For listing bumps — use the separate **"Auto-Bump"** button.

---

## 📂 Project Structure

```
├── background.js              # Service worker entry point
├── bg_constants.js            # Shared constants
├── bg_tab_manager.js          # Tab lifecycle manager
├── bg_playerok_api.js         # GraphQL bridge to Playerok
├── bg_dashboard.js            # Order scanner + 2FA monitoring
├── bg_fulfill.js              # Auto-fulfill state machine
├── bg_boost.js                # Listing bump loop
├── bg_publisher.js            # Bulk item publisher
│
├── content.js                 # DOM scanner on playerok.com
├── content_bridge.js          # GraphQL proxy (isolated world)
├── content_bridge_main.js     # Apollo cache reader (main world)
├── content_greeting.js        # Chat / 2FA automation
├── content_steampass.js       # SteamPass JWT extractor
│
├── popup.html / popup.js      # Side panel
├── auto_fulfill.*             # Auto-fulfill window
├── auto_boost.*               # Auto-bump window
├── auto_publisher.*           # Auto-publish window
├── dashboard.*                # Dashboard window
├── orders_history.*           # Order history
├── card_generator.*           # Card generator
│
├── manifest.json
├── rules.json                 # declarativeNetRequest rules
└── build.ps1                  # ZIP build script
```

---

## 🔑 Key Mechanics

### Auto-Fulfill — order state machine
```
NEW → GETTING_DATA → DATA_READY → GETTING_CREDENTIALS
    → SENDING_GREETING → WAITING_2FA → GETTING_2FA → COMPLETED
```
- 7s heartbeat, 24 deliveries per day limit (SteamPass cap)
- Up to 3 parallel orders (1 active + 2 in `WAITING_2FA`)
- Regex-based triggers on client chat messages

### Auto-Bump
- Scanner tab → finds expired listings → bumps one by one
- 7-day cooldown (`processedListingAt` Map)
- Random 3–6s delays between actions

### Concurrency controls
- `_storeMutexQueue` — sequential `chrome.storage` writes
- `_apiMutexQueue` — single GraphQL request in flight
- `_startBotLock` — guards against double-start

---

## 📋 Requirements

- Chromium-based browser with **Manifest V3** support (Chrome 114+, Edge 114+)
- Active accounts on Playerok and SteamPass
- Logged-in sessions on both services

> ⚠️ In browsers without `chrome.sidePanel` API (older Yandex/Opera), the side panel may not open via icon click — open windows directly via `chrome-extension://{id}/popup.html`.

---

## 🐛 Known Quirks

- Service Worker may sleep — heartbeat keeps it alive only while the bot is running
- On first launch you must visit SteamPass manually once so the extension can capture the JWT token
- Trigger regexes are tuned for Russian Playerok locale only

---

## 📄 License

This project is **dual-licensed**:

### 🟢 Open Source — AGPL-3.0
Free to use, fork and modify **under conditions**:
- Your fork's source must be public
- Derivative works must also be AGPL-3.0
- Attribution must be preserved

### 🔵 Commercial License
If you want to:
- Use this code in a **closed-source** commercial product
- Embed it in a SaaS without opening your code
- Resell under your own brand
- Get custom terms and support

→ **Contact me on Telegram [@dehughuglight](https://t.me/dehughuglight)** or by email at `leeds.eha@gmail.com`

See the [LICENSE](LICENSE) file for full details.

---

## 💬 Contacts

For any questions, bug reports, feature requests, or commercial licensing:

- **Telegram:** [@dehughuglight](https://t.me/dehughuglight) ⭐ (preferred, DM me)
- **Email:** leeds.eha@gmail.com
- **GitHub Issues:** for public bugs and feature requests

---

## 🤝 Contributing

Issues and PRs are welcome. The extension ships in open form **without minification** — for transparency and easier debugging.

---

## ⚠️ Disclaimer

This extension is intended for **personal use** by store account owners. Automation may violate the terms of service of third-party platforms — use at your own risk. The **author is not liable** for any account bans on Playerok, SteamPass, Steam, or any financial losses.
