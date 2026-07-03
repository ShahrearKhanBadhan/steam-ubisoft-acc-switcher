# Steam & Ubisoft Acc Switcher

A lightweight Tauri 2 desktop app for switching between Steam and Ubisoft
Connect accounts on Windows without logging in and out manually every time.

## Features

- **Steam account switching** — pulls saved accounts from Steam's local
  `loginusers.vdf`, shows avatar/persona name, and relaunches Steam logged in
  as the selected account.
- **Ubisoft Connect account switching** — snapshots each account's session
  files (cookies, local storage, `user.dat`) and restores the right snapshot
  on switch, so re-authentication isn't needed after switching back.
- Add/forget accounts from the tray-style popup window.
- Optional launch-at-startup via the Windows registry.
- Custom accent color and other lightweight settings.

## Requirements

- Windows
- Steam and/or Ubisoft Connect installed

## Development

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Tech stack

- [Tauri 2](https://tauri.app/) (Rust backend, vanilla HTML/CSS/JS frontend)
