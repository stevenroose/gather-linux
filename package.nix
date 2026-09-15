{
  lib,
  stdenv,
  makeWrapper,
  electron,
}:

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
    # This creates a 'gather-electron' command that runs:
    # electron /path/to/app --enable-features=WebRTCPipeWireCapturer
    makeWrapper ${electron}/bin/electron $out/bin/gather-linux \
      --add-flags "$out/libexec/gather-linux" \
      --add-flags "--enable-features=WebRTCPipeWireCapturer"

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
