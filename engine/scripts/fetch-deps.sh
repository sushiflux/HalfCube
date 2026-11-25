#!/usr/bin/env sh
# Fetches the engine's third-party sources into engine/_deps (git-ignored), pinned by the "fetch" blocks of
# third_party/manifest.json (POSIX counterpart of fetch-deps.ps1, used by CI on Linux). Git checkouts must end up at
# the pinned commit, archives and single files must match their SHA-256. Each folder gets a ".partcraft-pin" stamp;
# a folder whose stamp matches is kept. Needs git, curl, tar, sha256sum (or shasum) and node (reads the manifest).
#
#   sh engine/scripts/fetch-deps.sh [--skip occt] [--only eigen,boost]
set -eu

here=$(cd "$(dirname "$0")" && pwd)
engine=$(cd "$here/.." && pwd)
repo=$(cd "$engine/.." && pwd)
deps="$engine/_deps"
manifest="$repo/third_party/manifest.json"
skip=""
only=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip) skip="$skip,$2"; shift 2 ;;
    --only) only="$only,$2"; shift 2 ;;
    *) echo "fetch-deps.sh: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

for tool in git curl tar node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "fetch-deps.sh: $tool is required (not found on PATH)." >&2; exit 1; }
done
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
mkdir -p "$deps"

# One tab-separated line per action; the pin text is built exactly as in fetch-deps.ps1.
plan=$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const pin = (f) => f.kind === "git" ? `git ${f.url} ${f.commit}` + (f.sparse ? " sparse:" + f.sparse.join(",") : "")
  : f.kind === "archive" ? `archive ${f.url} ${f.sha256}`
  : "files " + f.files.map((e) => `${e.path}=${e.sha256}`).join(" ");
for (const c of m.components) {
  const f = c.fetch;
  if (!f || f.kind === "docker-image") continue;
  const head = [c.id, c.version, f.dir, pin(f)];
  if (f.kind === "git") console.log(["git", ...head, f.url, f.ref, f.commit, (f.sparse || []).join(" ")].join("\t"));
  else if (f.kind === "archive") console.log(["archive", ...head, f.url, f.sha256, f.stripComponents, f.members.join(" ")].join("\t"));
  else if (f.kind === "files") for (const e of f.files) console.log(["file", ...head, e.url, e.sha256, e.path].join("\t"));
}' "$manifest")

listed() { case ",$1," in *",$2,"*) return 0 ;; *) return 1 ;; esac; }
stamp_ok() { [ -f "$1/.partcraft-pin" ] && [ "$(cat "$1/.partcraft-pin")" = "$2" ]; }

tab=$(printf '\t')
done_ids=","
echo "$plan" | while IFS="$tab" read -r kind id version dir pin a b c d; do
  [ -n "$kind" ] || continue
  if [ -n "$only" ] && ! listed "$only" "$id"; then continue; fi
  if listed "$skip" "$id"; then echo "skipped: $id"; continue; fi
  target="$deps/$dir"
  if stamp_ok "$target" "$pin"; then
    listed "$done_ids" "$id" || echo "present: $id $version"
    done_ids="$done_ids$id,"
    continue
  fi
  case "$kind" in
    git)
      url=$a; ref=$b; commit=$c; sparse=$d
      if [ -d "$target/.git" ]; then
        have=$(git -C "$target" rev-parse HEAD)
        [ "$have" = "$commit" ] || { echo "$id: $target is at commit $have, but $commit ($ref) is pinned. Delete the folder and run again." >&2; exit 1; }
        printf '%s\n' "$pin" > "$target/.partcraft-pin"
        echo "verified: $id $version ($commit)"
        continue
      fi
      [ ! -e "$target" ] || { echo "$id: $target exists but is no git checkout. Delete the folder and run again." >&2; exit 1; }
      if [ -n "$sparse" ]; then
        git clone --quiet --depth 1 --branch "$ref" --filter=blob:none --sparse "$url" "$target"
        # shellcheck disable=SC2086
        git -C "$target" sparse-checkout set --cone $sparse
      else
        git clone --quiet --depth 1 --branch "$ref" "$url" "$target"
      fi
      have=$(git -C "$target" rev-parse HEAD)
      [ "$have" = "$commit" ] || { echo "$id: tag $ref of $url points to $have, but $commit is pinned (the tag was moved)." >&2; exit 1; }
      printf '%s\n' "$pin" > "$target/.partcraft-pin"
      echo "fetched: $id $version ($commit)"
      ;;
    archive)
      url=$a; sum=$b; strip=$c; members=$d
      [ ! -e "$target" ] || { echo "$id: $target exists without a matching .partcraft-pin stamp. Delete the folder and run again." >&2; exit 1; }
      tmp="$deps/.download-$id"
      rm -rf "$tmp" "$target.partial"
      mkdir -p "$tmp" "$target.partial"
      file="$tmp/$(basename "$url")"
      curl -fsSL -o "$file" "$url"
      got=$(sha256 "$file")
      [ "$got" = "$sum" ] || { echo "$id: SHA-256 of $url is $got, expected $sum." >&2; rm -rf "$tmp"; exit 1; }
      # shellcheck disable=SC2086
      tar -xzf "$file" -C "$target.partial" --strip-components="$strip" $members
      mv "$target.partial" "$target"
      rm -rf "$tmp"
      printf '%s\n' "$pin" > "$target/.partcraft-pin"
      echo "fetched: $id $version (SHA-256 verified)"
      ;;
    file)
      url=$a; sum=$b; path=$c
      out="$target/$path"
      mkdir -p "$(dirname "$out")"
      if [ ! -f "$out" ] || [ "$(sha256 "$out")" != "$sum" ]; then
        curl -fsSL -o "$out.partial" "$url"
        got=$(sha256 "$out.partial")
        [ "$got" = "$sum" ] || { echo "$id: SHA-256 of $url is $got, expected $sum." >&2; rm -f "$out.partial"; exit 1; }
        mv "$out.partial" "$out"
      fi
      # The stamp is written after each verified file; it only matches once the last file is in place.
      printf '%s\n' "$pin" > "$target/.partcraft-pin.next"
      all_ok=1
      for p in $(echo "$pin" | cut -d' ' -f2-); do
        fp=${p%%=*}; fs=${p#*=}
        if [ ! -f "$target/$fp" ] || [ "$(sha256 "$target/$fp")" != "$fs" ]; then all_ok=0; fi
      done
      if [ "$all_ok" = 1 ]; then mv "$target/.partcraft-pin.next" "$target/.partcraft-pin"; echo "fetched: $id $version (SHA-256 verified)"; else rm -f "$target/.partcraft-pin.next"; fi
      ;;
  esac
done
echo "dependencies ready in $deps"
