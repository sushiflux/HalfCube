// The only file that loads the `velopack` npm package. In the installed program the package sits in the packaged app's
// node_modules (installer/app/package.json; entry.cjs runs VelopackApp first and then loads main.cjs), so it is loaded
// lazily, only after the build is known to be packaged and not a dev build, and vite.desktop.config.ts keeps it external.
// Read for this file: velopack 1.2.161, lib/index.d.ts and lib/types.d.ts of the npm package, and in the Rust sources of the
// same tag src/lib-rust/src/manager.rs (UpdateManager), sources/github.rs and src/lib-nodejs/velopack_nodeffi/src/lib.rs.
import { createRequire } from "node:module";
import type * as VelopackModule from "velopack";
import type { UpdateInfo, VelopackAsset } from "velopack";
import type { FeedSource } from "./feed.ts";
import type { AdapterLoad, FoundUpdate, VelopackAdapter } from "./service.ts";

export interface VelopackAdapterOptions {
  feed: FeedSource;
  /** Loads the module; the default requires it next to this bundle (replaced in tests of other callers). */
  requireVelopack?: () => typeof VelopackModule;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function foundFromInfo(info: UpdateInfo): FoundUpdate {
  const target = info.TargetFullRelease;
  // With deltas the download is the sum of the delta packages; otherwise it is the full package (manager.rs, create_delta_update_strategy).
  // The Rust side serializes a missing base as null, which the type declaration does not say.
  const delta = Boolean(info.BaseRelease) && info.DeltasToTarget.length > 0;
  const downloadBytes = delta ? info.DeltasToTarget.reduce((sum, asset) => sum + asset.Size, 0) : target.Size;
  return { handle: info, version: target.Version, notesMarkdown: target.NotesMarkdown ?? "", downloadBytes, delta };
}

function foundFromAsset(asset: VelopackAsset): FoundUpdate {
  return { handle: asset, version: asset.Version, notesMarkdown: asset.NotesMarkdown ?? "", downloadBytes: asset.Size, delta: false };
}

/**
 * Builds the adapter on the real Velopack. "Not installed" shows as an exception of the UpdateManager constructor
 * (Error::NotInstalled, "This application is not properly installed: ..."), a portable copy as isPortable() true.
 */
export function loadVelopackAdapter(options: VelopackAdapterOptions): AdapterLoad {
  let velopack: typeof VelopackModule;
  try {
    // createRequire resolves from this bundle's folder upwards, so the packaged app's node_modules is found; a bundler
    // cannot follow the call, which keeps the package out of main.cjs.
    velopack = (options.requireVelopack ?? (() => createRequire(__filename)("velopack") as typeof VelopackModule))();
  } catch (error) {
    return { ok: false, reason: "not-installed", detail: `The velopack package could not be loaded: ${errorText(error)}` };
  }

  let manager: InstanceType<typeof VelopackModule.UpdateManager>;
  try {
    const source = options.feed;
    manager = new velopack.UpdateManager(
      source.kind === "github"
        ? new velopack.GithubSource(source.repoUrl, undefined, source.prerelease)
        : source.kind === "file"
          ? new velopack.FileSource(source.path)
          : new velopack.HttpSource(source.url),
    );
  } catch (error) {
    return { ok: false, reason: "not-installed", detail: errorText(error) };
  }
  if (manager.isPortable()) return { ok: false, reason: "portable", detail: "Velopack reports a portable copy." };

  const adapter: VelopackAdapter = {
    currentVersion: () => manager.getCurrentVersion(),
    check: async () => {
      const info = await manager.checkForUpdatesAsync();
      return info ? foundFromInfo(info) : null;
    },
    download: (update, onPercent) => manager.downloadUpdateAsync(update.handle as UpdateInfo, onPercent),
    pending: () => {
      const asset = manager.getUpdatePendingRestart();
      return asset ? foundFromAsset(asset) : null;
    },
    // silent = no progress window of the updater; restart = start HalfCube again afterwards. The updater waits for this
    // process to end (up to 60 s), so this only starts it.
    applyAfterExit: (update, restart) => {
      manager.waitExitThenApplyUpdate(update.handle as UpdateInfo | VelopackAsset, true, restart);
    },
  };
  return { ok: true, adapter };
}
