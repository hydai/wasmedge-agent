# WasmEdge readonly preopen "bind failure" — investigation report

**Date**: 2026-08-06
**Verdict**: **Not a WasmEdge bug.** The readonly preopen (`--dir guest:host:readonly`)
works correctly on every path tested, including macOS `/var/folders` temp trees, and
read-only enforcement is correct. All observed failures were caused by a **zsh
parameter-expansion modifier footgun** in the test commands themselves. Two small
upstream improvements are suggested at the end — one of them would have made this
issue self-diagnosing.

## Environment

| | |
|---|---|
| Host | macOS 26.5.2 (25F84), arm64, APFS |
| WasmEdge | 0.17.1 local build, source `WasmEdge/WasmEdge@845df599e`, wasi host code unchanged since `f3384c1c3` (2026-07-08) |
| Shell where the symptom appeared | zsh |
| Guest module | Rust `wasm32-wasip1` binary that reads `/workspace` and writes a file into it |

## Symptom (as first observed)

```console
$ T=$(mktemp -d)
$ wasmedge --dir /workspace:$T:readonly cell.wasm
[error] Bind guest directory failed:No such file or directory.
# execution continues with the mount absent
$ wasmedge --dir /workspace:$T cell.wasm     # same path, read-write
# works fine
```

The failure looked path-dependent in a deeply confusing way: `mktemp -d` paths under
`/var/folders` "always failed", literal paths under `$HOME` "always worked", a path
that failed once "started working" a minute later, and both the raw `/var/folders/...`
path and its `realpath` "failed" while `/tmp` and `/private/tmp` "worked". Hypotheses
about symlinked path components, path depth, directory age, single-character
components, xattrs (`com.apple.rootless`, `com.apple.provenance`), and the calling
process's seatbelt sandbox were each tested and each died against a counterexample.

Reading the source settled it: the readonly flag only changes the preopen *rights*;
the actual directory open in `VINode::bind` (`lib/host/wasi/vinode.cpp:98`) is
identical for rw and ro:

```cpp
WasiExpect<std::shared_ptr<VINode>> VINode::bind(..., std::string SystemPath) {
  EXPECTED_TRY(auto Node,
               INode::open(std::move(SystemPath), __WASI_OFLAGS_DIRECTORY,
                           __wasi_fdflags_t(0), VFS::Read));
  ...
}
```

A same-second rw-success/ro-failure on the same path is therefore impossible in this
code — which meant the two invocations were not actually receiving the same path.

## Root cause: zsh `:r` modifier

`set -x` on the failing command shows the argv WasmEdge actually received:

```console
$ T=$(mktemp -d)          # /var/folders/py/…/T/tmp.KVLF7h9NYx
$ set -x
$ wasmedge --dir /workspace:$T:readonly cell.wasm
+ wasmedge --dir /workspace:/var/folders/py/…/T/tmpeadonly cell.wasm
                                             ^^^^^^^^^^^^
```

zsh applies **history-style modifiers** to parameter expansions: `$T:r` means
"remove the extension of `$T`". So `$T:readonly` is parsed as `${T:r}` + literal
`eadonly`:

- `/…/T/tmp.KVLF7h9NYx` → `:r` strips `.KVLF7h9NYx` → `/…/T/tmp` → + `eadonly`
  → `/…/T/tmpeadonly` → **ENOENT**. (mktemp paths contain a dot — "always fails".)
- `/…/e/f` (no dot) → `:r` is a no-op → + `eadonly` → `/…/e/feadonly` → **ENOENT**.
- Literal paths (`/tmp/x:readonly`, `$HOME/sub/x:readonly` where the text adjacent
  to `:readonly` is not a variable expansion) are untouched — "always works".

This also explains the phantom "started working later": the retry was typed with a
literal path instead of `$D`. The modifier applies **inside double quotes** as well
(`"…:$T:readonly"` is equally mangled), which defeated the obvious quoting defense.

Correct forms in zsh:

```zsh
wasmedge --dir /workspace:${T}:readonly cell.wasm   # braces end the expansion
```

## Verified behavior (corrected matrix)

With the braced form, on WasmEdge 0.17.1:

| Host path | readonly bind | enforcement |
|---|---|---|
| `/var/folders/…/T/tmp.X` (mktemp) | ✅ | write → `ENOTCAPABLE` ✅ |
| `/private/var/folders/…` (realpath) | ✅ | ✅ |
| `/tmp/x`, `/private/tmp/x`, `/private/var/tmp/x` | ✅ | ✅ |
| `$HOME/...` various depths, incl. 0700 dirs, 1-char components | ✅ | ✅ |

Read-only enforcement is correct: reads and directory listing succeed; `fs::write`
inside the guest fails with WASI `ENOTCAPABLE` (errno 76).

## Suggested upstream improvements

1. **Include the host path in the bind error.** The current message
   (`lib/host/wasi/environ.cpp:105` and `:189`) reports only the errno:

   ```cpp
   spdlog::error("Bind guest directory failed:{}"sv, Res.error());
   ```

   Logging the received host path (and guest path) would have made this
   self-diagnosing — the mangled `tmpeadonly` would have been visible immediately:

   ```cpp
   spdlog::error("Bind guest directory {} to host path {} failed: {}"sv,
                 GuestDir, HostDir, Res.error());
   ```

   (Note `HostDir`/`GuestDir` are moved into `bind`; capture copies or log before
   the move.) Additionally, a failed `--dir` currently `continue`s and the module
   runs with the mount silently absent — worth considering whether a hard error
   (or at least a summary warning before `_start`) is friendlier.

2. **Docs note for zsh users.** In the `--dir` documentation (`wasmedge run --help`
   text and the book), show the readonly example in a zsh-safe spelling or add a
   caution that `$VAR:readonly` is mangled by zsh modifiers even inside double
   quotes; recommend `${VAR}:readonly`.

## Repro of the footgun itself

```zsh
# zsh only; bash is unaffected
T=$(mktemp -d)
print -r -- /workspace:$T:readonly     # → …/tmpeadonly   (mangled)
print -r -- /workspace:${T}:readonly   # → …/tmp.XXXX:readonly (correct)
```
