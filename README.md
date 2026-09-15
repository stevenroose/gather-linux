# Gather Linux

An unofficial, optimized **Gather Town** client for Linux.

This project wraps the Gather web client in Electron with specific tweaks to fix common Linux issues like **screen sharing on Wayland**, global hotkeys, and auto-away functionality.

<img src="assets/icon.png" alt="Gather Linux Icon" width="100"/>

## ✨ Features

- **Gather 2.0 & Classic:** Support for both the new Beta (default) and Classic versions.
- **Wayland Screen Sharing:** Native support for PipeWire to fix the infamous "black screen" issue on modern Linux (GNOME/KDE/Hyprland).
- **Smart Auto-Away:**
  - Detects system sleep/suspend and sets "Away" immediately.
- **Hotkeys Fixed:** Prevents Electron from swallowing critical game keys like `WASD` or `Ctrl+Shift+A`.

## 📥 Installation

### 1. Standard (Ubuntu, Fedora, Arch, etc.)

Download the latest **AppImage**, **.deb**, or **.rpm** from the [Releases Page](../../releases).

- **AppImage:** Just download, make executable (`chmod +x`), and run.
- **Deb/RPM:** Install via your package manager (`sudo apt install ./gather...deb`).

### 2. Nix (CLI)

Run instantly without installing:

```bash
nix run github:simonkoeck/gather-linux
```

Or install permanently to your user profile:

```bash
nix profile install github:simonkoeck/gather-linux
```

### 3. NixOS (System Configuration)

To install it declaratively on NixOS, add the repo to your `flake.nix` inputs:

In `flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # Add Gather Linux
    gather-linux.url = "github:simonkoeck/gather-linux";
  };

  outputs = { self, nixpkgs, gather-linux, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = { inherit gather-linux; }; # Pass input to modules
      modules = [ ./configuration.nix ];
    };
  };
}
```

In `configuration.nix`:

```nix
{ config, pkgs, gather-linux, ... }:

{
  environment.systemPackages = [
    gather-linux.packages.${pkgs.system}.default
  ];

  # Required for Screen Sharing on Wayland
  xdg.portal = {
    enable = true;
    xdgOpenUsePortal = true;
    config = {
      common.default = ["gtk"];
      hyprland.default = ["hyprland" "gtk"];
    };
    extraPortals = with pkgs; [
      xdg-desktop-portal-gtk
      xdg-desktop-portal-gnome
      xdg-desktop-portal-hyprland
    ];
  };
}
```

## 🚀 Usage

**GUI**

Launch Gather Linux from your application menu.

**CLI**

You can control the running instance from the terminal.

```bash
gather-linux
# or launch the classic (v1) version
gather-linux --classic
```

## 🛠 Troubleshooting

**Screen sharing is black or invisible?**

This usually means the app isn't talking to the Wayland Portal.

1. NixOS: Ensure xdg.portal.enable = true is in your config (see above).

1. Other Distros: Try launching with these flags to force Wayland mode:

   ```bash
   gather-linux --enable-features=UseOzonePlatform,WebRTCPipeWireCapturer --ozone-platform=wayland
   ```

**High CPU usage, fans spinning, `MESA-LOADER: failed to open dri` on startup?**

On NixOS the app loads the *host* GL and VA-API drivers from
`/run/opengl-driver/lib`, but its libc comes from this flake's `nixpkgs` input.
If the system is newer than the locked input, the host drivers can reference
glibc symbols the locked glibc does not have, for example:

```
MESA-LOADER: failed to open dri: .../glibc-2.40-66/lib/libc.so.6:
version `GLIBC_ABI_GNU2_TLS' not found (required by .../mesa-26.1.8/lib/libgallium-26.1.8.so)
```

Mesa then fails to load, EGL never initialises, the GPU process exits, and
Chromium falls back to SwiftShader software rendering. Everything still works,
it just burns several cores doing what the GPU should be doing.

The fix is to move the flake's `nixpkgs` forward so its glibc is at least as new
as the running system's:

```bash
nix flake update nixpkgs
```

Compare the two with `ldd --version` (the system) against
`nix eval --raw nixpkgs#glibc.version` for the locked input.

**Checking that the GPU is actually being used**

Open the dev tools console (`gather-linux --remote-debugging-port=9222`, then
visit `chrome://gpu` in a browser) and confirm that "Canvas", "Video Decode"
and "WebGL" read *Hardware accelerated*. `Software only` on any of them means
the app is doing that work on the CPU.

## 🏗 Development

```bash
# Install dependencies
npm install

# Run locally (with Wayland flags)
npm start

# Build for release (AppImage/Deb/RPM)
npm run dist
```

## 📝 License

[MIT](LICENSE)
