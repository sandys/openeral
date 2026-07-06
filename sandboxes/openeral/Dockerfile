# OpenEral sandbox — persistent /home/agent + read-only /db via just-bash
#
# Uses stock OpenShell (no custom cluster or gateway images needed).
# All filesystem virtualization happens in userspace via openeral-js.

FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest

USER root

# Node.js 22 LTS via NodeSource (apt nodejs conflicts with npm on Ubuntu Noble)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw — baked into the image so the sandbox doesn't reinstall on every launch.
# SHARP_IGNORE_GLOBAL_LIBVIPS=1 skips the sharp native postinstall, which would
# otherwise try to pull GitHub release assets (blocked in some CI environments).
#
# Pinned to 2026.4.29 — earlier 2026.4.24–2026.4.26 releases had a Docker regression
# where the embedded gateway never became healthy.
#
# Remove the amazon-bedrock-mantle extension: its bundled @anthropic-ai/sdk is
# internally broken in this openclaw release (client.js requires
# ./internal/utils/uuid.js, which the shipped package omits). Every plugin-load
# pass — including the TUI client's reconnect loop — throws a fatal
# PluginLoadFailureError, which pins the TUI at "connecting | idle" and spams the
# gateway log every ~8s. Config-level disables (plugins.entries.enabled=false and
# `openclaw plugins disable`) do NOT stop this load path; only removing the
# extension dir does, because openclaw discovers built-in plugins by scanning
# dist/extensions for openclaw.plugin.json (no central manifest references it).
# OpenEral only ever uses the Anthropic/StringCost provider, never AWS Bedrock,
# so dropping this plugin is a safe no-op.
# Also remove the amazon-bedrock, anthropic-vertex, and google provider
# extensions (OpenEral only ever uses the Anthropic direct / StringCost
# provider). They are not broken like mantle, but keeping them makes openclaw's
# runtime-dep resolver union their npm deps (@aws-sdk/client-bedrock*,
# @anthropic-ai/vertex-sdk, @google/genai, …) into the staged tree, and the
# plugin loader's wildcard-exports scan (collectRuntimePackageWildcardImport-
# Targets) then recursively walks those huge SDK trees on every TUI startup —
# measured as ~5 minutes at 100% CPU before the TUI could accept its gateway
# handshake (A/B verified: full tree = unbounded scan; pruned tree = ~19 s
# one-time startup). Removing the extensions collapses the staged union to the
# ~42 core deps: no runtime npm install AND no giant scan.
RUN SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error openclaw@2026.4.29 \
    && rm -rf /usr/lib/node_modules/openclaw/dist/extensions/amazon-bedrock-mantle \
    && rm -rf /usr/lib/node_modules/openclaw/dist/extensions/amazon-bedrock \
    && rm -rf /usr/lib/node_modules/openclaw/dist/extensions/anthropic-vertex \
    && rm -rf /usr/lib/node_modules/openclaw/dist/extensions/google \
    # Normalize every mtime in the openclaw tree to a WHOLE second. openclaw
    # names its compile-cache subdir after the package mtime in milliseconds
    # (e.g. openclaw/2026.4.29/<mtimeMs>-<n>/). Docker layer export truncates
    # mtimes to 1-second precision, so a cache baked during the build (mtime
    # .731) is keyed differently than what openclaw computes at runtime
    # (mtime .000) — the entire baked V8 bytecode cache is silently ignored
    # and every fresh sandbox recompiles ~43 MB of bytecode. Inside the
    # OpenShell sandbox that recompile ran for ~5 minutes at 100% CPU on the
    # first TUI launch, blocking the TUI event loop long enough that its
    # gateway websocket handshake timed out and the TUI stranded itself in a
    # "disconnected" state. Fixing the key mismatch makes the runtime reuse
    # the baked cache; the first TUI launch then compiles only a ~2 MB delta.
    && find /usr/lib/node_modules/openclaw -exec touch -h -d "@1735689600" {} + \
    && chmod -R a+rX /usr/lib/node_modules/openclaw

# Pre-stage OpenClaw's TUI plugin-runtime-deps AND pre-warm the V8 bytecode
# compile cache at image-build time so end users don't pay the multi-minute
# cold-start latency on first prompt.
#
# Why this is needed:
#   1. OpenClaw lazy-loads its TUI plugins on first agent interaction. Some of
#      those plugins declare deps as `git+ssh://git@github.com/…` (e.g.
#      whiskeysockets/libsignal-node), which the OpenShell sandbox policy blocks
#      at the network layer. The user-visible symptom is a ~10 min hang on the
#      very first "hi" and subsequent npm error 128 failures.
#   2. OpenClaw is huge (74 MB unpacked, 9309 files) and lazy-loads most of
#      itself on the first agent message. The gateway's own embedded-run trace
#      shows ~54 s of synchronous CPU on first prompt:
#        model-resolution:6.8s, auth:4.1s, core-plugin-tools:14.1s,
#        system-prompt:8.7s, stream-setup:9.0s, attempt-dispatch:7.7s
#      OpenClaw doctor flags this directly: "NODE_COMPILE_CACHE points to /tmp;
#      use /var/tmp so cache survives reboots." We can't use /var/tmp (sandbox
#      policy makes /tmp the only writable scratch path), but /opt is writable
#      at build time and we can bake the V8 bytecode cache there, then seed it
#      to /tmp on every sandbox launch — same effect.
#
# Steps:
#   1. Rewrite git+ssh GitHub URLs to https (same as setup.sh).
#   2. Run `openclaw status --deep` with NODE_COMPILE_CACHE pointing at
#      /opt/openclaw-compile-cache. Forces plugin discovery + dependency
#      resolution AND populates the V8 bytecode cache for the status/health
#      code path.
#   3. Run a handful of other openclaw subcommands (models list, plugins list,
#      infer model list) to broaden cache coverage. These all share most of
#      openclaw's bootstrap code path.
#   4. Write a fake auth profile via non-interactive `openclaw onboard`, then
#      run `openclaw agent --local`. --local preloads the plugin registry and
#      runs the embedded agent in-process, exercising the exact pipeline the
#      gateway trace flagged — model-resolution, auth, core-plugin-tools,
#      system-prompt, stream-setup. The Anthropic API call fails (fake key) but
#      every module loaded up to that point gets JIT-compiled and the bytecode
#      lands in /opt/openclaw-compile-cache.
#   5. Copy plugin-runtime-deps to /opt/openclaw-plugin-cache (existing logic).
#   6. HARD GATE: fail the build if the plugin cache came out empty. Every
#      pre-warm step above is `|| true`, so a network-restricted build
#      environment can silently produce an image with no staged plugins.
#      Shipping such an image forces the gateway to stage all ~35 bundled
#      runtime deps at runtime inside the network-restricted sandbox — the
#      staging hangs, /readyz never responds, and the user sees the gateway
#      "crash" after a 10-minute wait.
#   7. Make /opt/openclaw-compile-cache world-readable so the sandbox user can
#      seed it at runtime.
# CRITICAL: plugin runtime deps are staged at /tmp/openclaw-plugin-runtime-deps —
# the EXACT path setup.sh uses at runtime (OPENCLAW_PLUGIN_STAGE_DIR for the
# gateway; ~/.openclaw/plugin-runtime-deps is a symlink to it for the TUI).
# Node's compile cache is keyed per source-file PATH, so bytecode compiled at
# build time under a different path (the old /tmp/openclaw-bootstrap/.openclaw/
# location) is a guaranteed runtime cache miss: the first TUI launch then
# recompiled ~40 MB of plugin-dep bytecode at 100% CPU for ~5 minutes inside
# the sandbox, its gateway handshake timed out meanwhile, and the TUI stranded
# itself in a disconnected state. Staging and compiling at the runtime path
# makes the baked bytecode valid at runtime.
#
# EQUALLY CRITICAL: the prewarm must run AS THE SANDBOX USER. Node namespaces
# compile-cache directories by uid (v<ver>-<arch>-<hash>-<uid>): bytecode
# written by root lands in …-0/ and is entirely invisible to the runtime
# sandbox user (uid 998), which reads …-998/ — the same 5-minute recompile
# storm through a different keyhole. Pre-create the /opt cache dirs and hand
# them to the sandbox user before dropping privileges.
RUN mkdir -p /opt/openclaw-compile-cache /opt/openclaw-plugin-cache \
    && chown -R sandbox:sandbox /opt/openclaw-compile-cache /opt/openclaw-plugin-cache
USER sandbox
RUN set -e \
 && mkdir -p /tmp/openclaw-bootstrap/.openclaw /opt/openclaw-compile-cache /tmp/openclaw-plugin-runtime-deps \
 && ln -s /tmp/openclaw-plugin-runtime-deps /tmp/openclaw-bootstrap/.openclaw/plugin-runtime-deps \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "git@github.com:" \
 && HOME=/tmp/openclaw-bootstrap git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" \
 && HOME=/tmp/openclaw-bootstrap git config --global http.sslVerify false \
 && export HOME=/tmp/openclaw-bootstrap \
           NODE_COMPILE_CACHE=/opt/openclaw-compile-cache \
           OPENCLAW_PLUGIN_STAGE_DIR=/tmp/openclaw-plugin-runtime-deps \
           GIT_SSL_NO_VERIFY=true \
           npm_config_strict_ssl=false \
           OPENCLAW_NO_RESPAWN=1 \
           OPENCLAW_SKIP_ONBOARDING=1 \
 # 1. status --deep: forces plugin discovery + npm-via-git deps; primes most
 #    of the status/health code path into NODE_COMPILE_CACHE.
 && timeout 900 openclaw status --deep </dev/null >/tmp/openclaw-bootstrap.log 2>&1 || true \
 # 2. Broaden coverage with cheap subcommands that share most of the bootstrap.
 && timeout 60 openclaw models list  </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && timeout 60 openclaw plugins list </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && timeout 60 openclaw infer list   </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 # 3. Pre-warm the embedded-agent run path (the slow one in the gateway trace:
 #    model-resolution, auth, core-plugin-tools, system-prompt, stream-setup).
 #    We write a fake auth profile via non-interactive onboarding, then run
 #    `openclaw agent --local`. The Anthropic API call WILL fail (fake key),
 #    but every module loaded up to that point gets JIT-compiled and the
 #    bytecode lands in /opt/openclaw-compile-cache.
 && timeout 60 openclaw onboard --non-interactive \
      --mode local --auth-choice apiKey \
      --anthropic-api-key "sk-ant-prewarm-fake-not-a-real-key-do-not-use" \
      --secret-input-mode plaintext \
      --gateway-port 18799 --gateway-bind loopback \
      --skip-bootstrap --skip-skills --accept-risk \
      </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && timeout 120 openclaw agent --local --agent main --message "warm" --timeout 60 \
      </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 # 3b. Start the gateway once, with network available. Only the gateway/TUI
 #     code path runs the SECOND staging pass, which unions in the
 #     extension-specific model-provider deps for the onboarded config
 #     (@anthropic-ai/vertex-sdk, @aws-sdk/client-bedrock*, @google/genai, … —
 #     see resolveBundledRuntimeDepsConfiguredModelOwnerPluginIds in openclaw's
 #     bundled-runtime-deps chunk). `status --deep` / `agent --local` above do
 #     NOT trigger it. If these deps are missing from the baked cache, the
 #     first TUI launch inside the network-restricted sandbox rewrites the
 #     staged package.json with the bigger union and spawns a live
 #     `npm install` that crawls through the egress proxy with ECONNRESET
 #     retries for 15+ minutes — during which the TUI is completely frozen
 #     ("connecting | idle", no keyboard input). With the union baked, the
 #     runtime staging pass finds every spec satisfied and skips npm entirely
 #     (a millisecond no-op). doctor --fix first: the second pass only runs
 #     once the plugin registry is consolidated (mirrors setup.sh order).
 && timeout 120 openclaw doctor --fix </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && (openclaw gateway --port 18799 --allow-unconfigured </dev/null >>/tmp/openclaw-bootstrap.log 2>&1 &) \
 # With the bedrock/vertex/google extensions removed above, the second-pass
 # union collapses to the core dep set, which the gateway stages before it
 # starts. Wait only for staging quiescence (no npm) + a core dep sentinel.
 && _d=0 \
 && while [ $_d -lt 240 ]; do \
        if ls -d /tmp/openclaw-plugin-runtime-deps/*/node_modules/express >/dev/null 2>&1 \
           && ! ps -e -o comm= | grep -q "^npm" 2>/dev/null; then break; fi; \
        sleep 5; _d=$((_d+5)); \
    done \
 && echo "--- staging wait: ${_d}s ---" >>/tmp/openclaw-bootstrap.log \
 # 3c. Run the TUI once under a PTY while the gateway is up, mirroring the
 #     runtime launch (no OPENCLAW_PLUGIN_STAGE_DIR in its env, HOME symlink
 #     provides the stage dir — exactly like setup.sh's exec). This compiles
 #     the TUI-only module set into the baked cache. TERM must be set (docker
 #     build has none, and without it the TUI exits before loading anything).
 #     V8 compiles this set at only ~6 MB of bytecode per minute, so the first
 #     pass gets a long budget; the second pass resumes incrementally (already
 #     -cached modules are skipped) and mops up whatever the first pass was
 #     killed in the middle of. Sizes are echoed for build-log visibility.
 && du -s /opt/openclaw-compile-cache | cut -f1 > /tmp/cc-before-tui \
 && TERM=xterm-256color env -u OPENCLAW_PLUGIN_STAGE_DIR \
      script -qec "timeout 480 openclaw tui" /dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && TERM=xterm-256color env -u OPENCLAW_PLUGIN_STAGE_DIR \
      script -qec "timeout 180 openclaw tui" /dev/null >>/tmp/openclaw-bootstrap.log 2>&1 || true \
 && du -s /opt/openclaw-compile-cache | cut -f1 > /tmp/cc-after-tui \
 && echo "--- compile cache KB before/after TUI prewarm: $(cat /tmp/cc-before-tui) / $(cat /tmp/cc-after-tui) ---" \
 && pkill -f "openclaw gateway" 2>/dev/null || true \
 && sleep 2 \
 # 4. Copy the staged plugin-runtime-deps to the baked cache. --preserve keeps
 #    mtimes stable so nothing about the tree changes between build and the
 #    runtime seed back to the same /tmp path.
 && mkdir -p /opt/openclaw-plugin-cache \
 && cp -r --preserve=timestamps /tmp/openclaw-plugin-runtime-deps/. \
        /opt/openclaw-plugin-cache/ 2>/dev/null || true \
 # 5. Hard gate: an empty plugin cache means the pre-warm silently failed.
 && if [ -z "$(ls -A /opt/openclaw-plugin-cache 2>/dev/null)" ]; then \
        echo "ERROR: /opt/openclaw-plugin-cache is empty — OpenClaw plugin pre-stage failed." >&2; \
        echo "An image without staged plugins makes the sandbox gateway hang at startup." >&2; \
        echo "--- tail of /tmp/openclaw-bootstrap.log ---" >&2; \
        tail -100 /tmp/openclaw-bootstrap.log >&2 || true; \
        exit 1; \
    fi \
 # 5b. Hard gate: the staged install MANIFEST must be the CORE set only.
 #     openclaw's plugin loader walks the wildcard-exports tree of every
 #     DIRECT manifest dep on TUI startup; if the manifest unions in the
 #     AWS/Vertex/Google SDK specs again (extension removal regressed), that
 #     walk takes minutes at 100% CPU. Transitive @aws-sdk/@google trees
 #     pulled in by core deps (e.g. @mariozechner/pi-ai) are fine — the
 #     loader does not walk transitive deps — so only the manifest is checked.
 && if grep -lE "@aws-sdk/|@anthropic-ai/vertex-sdk|@google/genai" /opt/openclaw-plugin-cache/*/package.json >/dev/null 2>&1; then \
        echo "ERROR: AWS/Vertex/Google SDK specs present in the staged manifest — extension removal regressed." >&2; \
        grep -hE "@aws-sdk/|vertex-sdk|@google/genai" /opt/openclaw-plugin-cache/*/package.json >&2 || true; \
        exit 1; \
    fi \
 && if ! ls -d /opt/openclaw-plugin-cache/*/node_modules/express >/dev/null 2>&1; then \
        echo "ERROR: core dep sentinel (express) missing from /opt/openclaw-plugin-cache." >&2; \
        echo "--- tail of /tmp/openclaw-bootstrap.log ---" >&2; \
        tail -100 /tmp/openclaw-bootstrap.log >&2 || true; \
        exit 1; \
    fi \
 # 5c. Hard gate: the TUI prewarm must have ADDED bytecode to the cache
 #     (~19 MB observed for openclaw 2026.4.29; the prewarmed cache converges
 #     at ~46 MB total — a second longer TUI pass adds nothing further). A
 #     near-zero delta means the prewarm silently did nothing (this happened
 #     twice: once for a missing TERM, once for a compile-cache key mismatch)
 #     and the first in-sandbox TUI launch would freeze for minutes
 #     recompiling the TUI module set.
 && _ccb=$(cat /tmp/cc-before-tui) && _cca=$(cat /tmp/cc-after-tui) \
 && if [ $((_cca - _ccb)) -lt 10000 ]; then \
        echo "ERROR: TUI prewarm grew the compile cache by only $((_cca - _ccb)) KB (${_ccb} -> ${_cca})." >&2; \
        echo "Expected >= 10 MB of TUI bytecode — the prewarm silently did nothing." >&2; \
        echo "--- tail of /tmp/openclaw-bootstrap.log ---" >&2; \
        tail -60 /tmp/openclaw-bootstrap.log >&2 || true; \
        exit 1; \
    fi \
 # 6. Lock down perms and log cache size for visibility during build.
 && chmod -R a+rX /opt/openclaw-plugin-cache /opt/openclaw-compile-cache \
 && echo "--- compile cache size ---" >>/tmp/openclaw-bootstrap.log \
 && du -sh /opt/openclaw-compile-cache 2>&1 | tee -a /tmp/openclaw-bootstrap.log || true \
 # Kill any openclaw background processes left over from the pre-warm `agent
 # --local` run (MCP loopback / plugin daemons can briefly outlive the foreground
 # process and race with rm). Then clean up the throwaway dirs. The rm is
 # best-effort — we already copied everything we need to /opt, so a couple of
 # leftover MB in /tmp is harmless if the rm partially fails.
 && pkill -9 -f openclaw 2>/dev/null || true \
 && sleep 2 \
 && rm -rf /tmp/openclaw-bootstrap /tmp/openclaw-bootstrap.log /tmp/openclaw-plugin-runtime-deps 2>/dev/null || true
USER root

# Install openeral-js: install all deps (including devDeps for tsc), build, then prune
COPY openeral-js/ /opt/openeral/
RUN cd /opt/openeral && npm install && npm run build && npm prune --omit=dev \
    && chmod -R a+rX /opt/openeral \
    && chown -R sandbox:sandbox /opt/openeral

# openeral-bash: drop-in bash replacement routed through just-bash
COPY --chown=sandbox:sandbox sandboxes/openeral/openeral-bash.mjs /opt/openeral/openeral-bash.mjs
RUN chmod a+rx /opt/openeral/openeral-bash.mjs \
    && ln -sf /opt/openeral/openeral-bash.mjs /usr/local/bin/openeral-bash

# Rename real bash so openeral-bash can fall back to it for interactive use
RUN cp /bin/bash /bin/bash.real

# Setup script (entry point for sandbox create).
#
# Users invoke this as the trailing command of `openshell sandbox create`.
# OpenShell doesn't honour Docker ENTRYPOINT/CMD — the image's native entry is
# overridden by openshell's own supervisor, and an empty trailing command just
# leaves the pod asleep. Shipping a short /usr/local/bin/openeral shim lets the
# end-user command end in `-- openeral` instead of `-- /opt/openeral/setup.sh`.
COPY sandboxes/openeral/setup.sh /opt/openeral/setup.sh
RUN chmod 755 /opt/openeral/setup.sh \
    && chown sandbox:sandbox /opt/openeral/setup.sh \
    && ln -sf /opt/openeral/setup.sh /usr/local/bin/openeral

# Override the upstream base policy
COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml

# Skills for Claude Code
COPY .claude/skills/ /sandbox/.skills/

# Workspace directory — must be owned by sandbox user so setup.sh can write .npmrc
RUN mkdir -p /home/agent && chown sandbox:sandbox /home/agent
