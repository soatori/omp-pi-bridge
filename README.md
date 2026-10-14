# OMP Pi Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

An Oh My Pi (OMP) extension that reads providers and models from Pi configuration, then writes OMP token usage and session records as Pi-compatible session files for CC Switch’s existing Pi scanner.

**This is an OMP extension, not a Pi extension.** `package.json` declares `omp.extensions` only; it does not declare `pi.extensions`. Pi is the configuration source and session-file format. Do not copy this extension into Pi’s `~/.pi/agent/extensions`: it could mirror Pi’s own sessions back into Pi. See the [OMP extension guide](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md) and the [Pi extension guide](https://pi.dev/docs/latest/extensions).

## Features and data boundaries

- At startup, the extension reads Pi’s `models.json` and registers providers, API types, endpoints, key references, and models in the OMP runtime.
- Historical OMP sessions backfill token usage only; historical prompts and replies are not copied.
- Live OMP conversations mirror full messages, tool results, and token usage. Live records include tool inputs and outputs.
- The extension does not write Pi API configuration or read or modify CC Switch configuration or databases.
- If Pi has no configured providers, the first session startup asks whether to sync. The default is to skip for this run. Declining, canceling, or running without an interactive prompt means the current OMP process will not backfill or write Pi sessions. Choosing to sync applies only to the current OMP process.

## Installation

### Native Windows installer

From the project directory, run this in PowerShell:

```powershell
.\install.ps1
```

The script copies the extension into the current OMP profile’s extension directory and, when needed, adds an existing Bun executable directory to the user `PATH`. It does not install OMP or Bun. Restart OMP after installation.

To specify a named profile:

```powershell
.\install.ps1 -Profile work
```

You can also set the profile for the current PowerShell session first:

```powershell
$env:OMP_PROFILE = 'work'
.\install.ps1
```

### OMP plugin manager

You can also install it from GitHub with the OMP plugin manager:

```powershell
omp plugin install github:soatori/omp-pi-bridge
```

Use one installation method to avoid loading the extension twice.

## Configuration

By default, the extension reads `%USERPROFILE%\.pi\agent\models.json`. If your Pi configuration directory is elsewhere, set `OMP_PI_CONFIG_DIR`:

```powershell
$env:OMP_PI_CONFIG_DIR = 'D:\Pi\agent'
```

`PI_CODING_AGENT_DIR` configures OMP’s own agent directory; it does not select the Pi configuration directory.

Pi’s `settings.json` `sessionDir` setting or `PI_CODING_AGENT_SESSION_DIR` can specify an absolute session directory. Relative paths cannot be scanned globally by CC Switch, so the extension skips them and displays a notice.

## Uninstallation

To remove an extension installed with the native script:

```powershell
.\uninstall.ps1
```

To remove it from a named profile:

```powershell
.\uninstall.ps1 -Profile work
```

To remove it through the OMP plugin manager:

```powershell
omp plugin uninstall omp-pi-bridge
```

`uninstall.ps1` removes only the `omp-pi-bridge` extension directory from the selected profile. It preserves Pi session history, OMP sync state, configuration files, and shared `PATH` entries. Restart OMP after uninstalling.

## Development and verification

Bun and Windows PowerShell are required:

```powershell
bun test test
bun run build-check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/install-profile.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/uninstall-profile.ps1
```

Tests cover provider sync, confirmation for an empty Pi configuration, historical and live session conversion, profile paths, uninstall preservation, and concurrent state writes.

## Compatibility and behavior

- Verified with OMP 18.10.3 and CC Switch 4.0.7 on Windows.
- OMP branches are flattened in execution order in the Pi mirror. Resume work from the original OMP session.
- Full live sessions may appear in the Pi or CC Switch session list.
- Cost display depends on OMP usage data and model pricing available to CC Switch.
