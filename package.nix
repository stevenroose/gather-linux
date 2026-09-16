{
  lib,
  stdenv,
  makeWrapper,
  electron,
  xdg-utils,
}:

let
  # Chromium only honours a single --enable-features / --disable-features
  # occurrence, so every feature toggle has to live in these two lists.
  enableFeatures = [
    # Screen sharing through the xdg-desktop-portal / PipeWire path.
    "WebRTCPipeWireCapturer"
    # Client-side decorations when running natively on Wayland.
    "WaylandWindowDecorations"
    # Hardware video decode/encode (VA-API). Gather is a WebRTC app, so this
    # moves the per-participant video work off the CPU.
    "VaapiVideoDecodeLinuxGL"
    "VaapiVideoEncoder"
    "AcceleratedVideoEncoder"
  ];

  disableFeatures = [
    # Chromium grabbing the media keys over MPRIS is not useful here.
    "HardwareMediaKeyHandling"
    # The Wayland ozone backend cannot create a Vulkan surface, so anything
    # that reaches for Vulkan logs an error and falls back:
    #   '--ozone-platform=wayland' is not compatible with Vulkan.
    # Electron 43 carries Skia Graphite and the ANGLE Vulkan backends, so the
    # GL path has to be selected explicitly rather than left to the blocklist.
    "SkiaGraphite"
    "Vulkan"
    "VulkanFromANGLE"
    "DefaultANGLEVulkan"
  ];

  flags = [
    # Run natively on Wayland when there is a Wayland session, which avoids the
    # XWayland copy of every frame; falls back to X11 when there is not.
    "--ozone-platform-hint=auto"
    "--enable-features=${lib.concatStringsSep "," enableFeatures}"
    "--disable-features=${lib.concatStringsSep "," disableFeatures}"
    # Let the GPU do the rasterising and skip intermediate copies.
    "--enable-gpu-rasterization"
    "--enable-zero-copy"
    # Integrated GPUs are frequently blocklisted for rasterisation and video
    # acceleration even when both work fine. This also lifts the gating that
    # keeps Vulkan off, which is why the features above are disabled by name.
    "--ignore-gpu-blocklist"
    # Keep ANGLE on the desktop GL backend instead of letting it pick Vulkan.
    "--use-angle=gl"
    # Gather is a single origin, so one renderer per site instead of one per
    # frame saves a few hundred MB of resident memory.
    "--process-per-site"
  ];
in
stdenv.mkDerivation {
  pname = "gather-linux";
  version = "1.0.6";

  # Use the current directory as the source
  src = ./.;

  nativeBuildInputs = [ makeWrapper ];

  # No build needed (just copying files)
  dontBuild = true;

  installPhase = ''
    # 1. Create directory for app source
    mkdir -p $out/libexec/gather-linux
    mkdir -p $out/share/icons/hicolor/512x512/apps

    # 2. Copy the main files
    cp main.js package.json $out/libexec/gather-linux/
    # Copy the assets
    cp assets/icon.png $out/share/icons/hicolor/512x512/apps/gather-linux.png

    # 3. Create the binary wrapper
    # Flags are added before the user's own arguments, so anything passed on
    # the command line still wins (e.g. --ozone-platform=x11).
    makeWrapper ${electron}/bin/electron $out/bin/gather-linux \
      --add-flags "$out/libexec/gather-linux" \
      ${lib.concatStringsSep " \\\n      " (map (f: ''--add-flags "${f}"'') flags)} \
      --prefix PATH : ${lib.makeBinPath [ xdg-utils ]}

    mkdir -p $out/share/applications
    cp gather.desktop $out/share/applications/
  '';

  meta = {
    description = "Unofficial Gather Town client for Linux";
    homepage = "https://github.com/simonkoeck/gather-linux";
    license = lib.licenses.mit;
    mainProgram = "gather-linux";
    platforms = lib.platforms.linux;
  };
}
