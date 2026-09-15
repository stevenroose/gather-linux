{
  description = "Gather Town Electron Wrapper";

  inputs = {
    # NOTE: on NixOS the app dlopens the *host* GL and VA-API drivers out of
    # /run/opengl-driver/lib, while the rest of the process (libc included)
    # comes from this input. If this input is older than the running system,
    # those drivers can need glibc symbols that are missing here, Mesa fails to
    # load, and the app silently drops to software rendering. Keep this input
    # at least as new as the system (`nix flake update`), or install the
    # package through `overlays.default` so it is built from the system's own
    # nixpkgs and the two can never drift apart.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    {
      # Build against whatever nixpkgs the consumer already uses. On NixOS this
      # is the safest way to install it: the app and the system graphics stack
      # then share one glibc, one Mesa and one Electron in the store.
      overlays.default = final: prev: {
        gather-linux = final.callPackage ./package.nix { };
      };
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.callPackage ./package.nix { };

        # This allows you to run `nix run` immediately
        apps.default = flake-utils.lib.mkApp {
          drv = self.packages.${system}.default;
        };
      }
    );
}
