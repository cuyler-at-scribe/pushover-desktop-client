[![Build Status](https://travis-ci.org/nbrownus/pushover-desktop-client.svg)](https://travis-ci.org/nbrownus/pushover-desktop-client)

### About

`pushover-desktop-client` is a tool written in [node.js](https://node.js) to display [Pushover](https://pushover.net)
notifications on your desktop. ~~It uses [node-notifier](https://github.com/mikaelbr/node-notifier)~~ `electron` with a custom GUI based on `electron-toast`, so it should work
with many different desktop notification providers on many different operating systems.

### Using it

> **Prerequisites**
>
> This integrates with the Pushover service, which is a long-running lightweight notification service that has been around since ~2010.
>
> You'll need a Pushover account **with a paid "Pushover for Desktop" license** attached to it. At the time of this writing, this involves a one-time fee of only $5.
>
> See the official [Pushover Open Client API documentation](https://pushover.net/api/client) for full details.

## Quick Start (local run)

The easiest way to try the desktop client is to run it straight from the cloned repository with **npx**:

```bash
npm install       # install dependencies
npx .             # launch the Electron app & first-run wizard
```

On the very first launch the Electron-based setup wizard will guide you through:

1. Signing in to your Pushover account (2-factor supported)
2. Registering a _device name_ for this computer

The credentials are stored securely in `~/.config/pushover-dc/settings.json` (or the appropriate XDG location) and subsequent launches skip the wizard.

After the initial run you can simply execute `npx .` again or use the provided npm script:

```bash
npm run pushover
```

### Using with MCP:

There's a handful of MCP servers that integrate with Pushover to send notifications from your IDE (or other MCP-compatible clients).

I use [pushover-mcp](https://github.com/AshikNesin/pushover-mcp), which (at the time of this writing) you can set up in Cursor by clicking "add new MCP server" and then adjusting the JSON you see there accordingly _(as long as Node is installed and is set to a reasonable version, you shouldn't need to directly install any depedencies)_:

```json5
{
  mcpServers: {

    // [... potentially other MCP servers...]

    pushover: {
      command: "npx",
      args: [
        "-y",
        "pushover-mcp@latest",
        "start",
        "--token",
        // Get your API token from:
        // https://pushover.net/apps/build
        "your API token goes here",
        "--user",
        // Not your email!
        // Get from the Pushover dashboard's front page
        "your user id goes here",
      ],
    },

    // [... potentially other MCP servers...]

  },
}
```

## Environment overrides

The client honors a few environment variables if you need to script or containerise it:

- `PUSHOVER_DEVICE_ID` – device id
- `PUSHOVER_SECRET` – user secret
- `PUSHOVER_SETTINGS_PATH` – full path to the settings JSON (overrides default XDG path)
- `PUSHOVER_IMAGE_CACHE` – directory for caching app icons

_These variables are **optional** – the interactive wizard will obtain and save everything for you. Only set them when running the client in a non-interactive environment (e.g. a Docker container or a CI job)._

### Where are my credentials stored?

After completing the wizard your device ID, user secret, and other preferences are saved to:

```text
~/.config/pushover-dc/settings.json   # Linux/macOS (XDG compliant)
%APPDATA%\pushover-dc\settings.json  # Windows
```

You usually never need to look at or edit that file manually.