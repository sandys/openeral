import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const policy = readFileSync(join(repoRoot, 'sandboxes/openeral/policy.yaml'), 'utf8');
const setup = readFileSync(join(repoRoot, 'sandboxes/openeral/setup.sh'), 'utf8');
const claudeWrapper = readFileSync(join(repoRoot, 'sandboxes/openeral/openeral-claude.sh'), 'utf8');
const cli = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

describe('proxy policy (PROXY-PLAN compliance)', () => {
  it('has no secret_injection: fields (stock SecretResolver handles it)', () => {
    expect(policy).not.toMatch(/secret_injection:/);
  });

  it('has no egress_via: fields (not in stock OpenShell)', () => {
    expect(policy).not.toMatch(/egress_via:/);
  });

  it('has no egress_profile: fields (not in stock OpenShell)', () => {
    expect(policy).not.toMatch(/egress_profile:/);
  });

  it('routes inference through the inspectable mandatory Haloop edge', () => {
    const haloopSection = policy.slice(
      policy.indexOf('haloop_anthropic:'),
      policy.indexOf('\n  #', policy.indexOf('haloop_anthropic:') + 1),
    );
    expect(haloopSection).toContain('host: host.openshell.internal');
    expect(haloopSection).toContain('port: 8787');
    expect(haloopSection).toContain('protocol: rest');
    expect(haloopSection).toContain('enforcement: enforce');
    expect(haloopSection).not.toContain('tls: skip');
    expect(policy).not.toContain('api.anthropic.com');
  });

  it('Haloop policy allows fixed native agents but not generic Node', () => {
    const haloopStart = policy.indexOf('haloop_anthropic:');
    const nextPolicy = policy.indexOf('\n  #', haloopStart + 1);
    const haloopBlock = policy.slice(haloopStart, nextPolicy > 0 ? nextPolicy : undefined);
    expect(haloopBlock).toContain('/usr/local/bin/claude');
    expect(haloopBlock).toContain('/usr/local/bin/claude-real');
    expect(haloopBlock).toContain('/usr/local/bin/openrind-openclaw-agent');
    expect(haloopBlock).not.toContain('/usr/bin/node');
  });

  it('keeps the writable filesystem rooted at current OpenShell paths', () => {
    expect(policy).toContain('- /sandbox');
    expect(policy).toContain('- /tmp');
    expect(policy).not.toMatch(/- \/home(?:\/|\*|$)/m);
    expect(policy).not.toMatch(/- \/mnt(?:\/|\*|$)/m);
  });

  it('keeps retired presign policy and JSON credential rewrite removed', () => {
    expect(policy).not.toContain('openrind_gateway_presign:');
    expect(policy).not.toContain('stringcost_presign:');
    expect(policy).not.toContain('host: app.openrind.com');
    expect(policy).not.toContain('host: app.stringcost.com');
    expect(policy).not.toContain('request_body_credential_rewrite: true');
    expect(policy).not.toContain('path: /v1/presign');
  });

  it('keeps retired direct proxy hosts out of the primary policy', () => {
    expect(policy).not.toContain('stringcost_proxy:');
    expect(policy).not.toContain('host: proxy.openrind.com');
    expect(policy).not.toContain('host: proxy.stringcost.com');
  });

  it('uses the constrained Supabase pooler wildcard', () => {
    expect(policy).toContain('host: "*.pooler.supabase.com", port: 5432, tls: skip');
    expect(policy).toContain('host: "*.pooler.supabase.com", port: 6543, tls: skip');
    expect(policy).not.toContain('aws-0-ap-south-1.pooler.supabase.com');
  });

  it('keeps Socket.dev inspectable instead of bypassing TLS', () => {
    expect(policy).toContain('registry.socket.dev');
    const socketSection = policy.slice(
      policy.indexOf('registry.socket.dev'),
      policy.indexOf('binaries:', policy.indexOf('registry.socket.dev')),
    );
    expect(socketSection).toContain('protocol: rest');
    expect(socketSection).not.toContain('tls: skip');
  });

  it('Socket.dev endpoint is read-only (not access: full)', () => {
    const socketSection = policy.slice(
      policy.indexOf('registry.socket.dev'),
      policy.indexOf('binaries:', policy.indexOf('registry.socket.dev')),
    );
    expect(socketSection).toContain('access: read-only');
    expect(socketSection).not.toContain('access: full');
  });

  it('Socket.dev policy allows npm and node (node is the actual exe)', () => {
    const socketStart = policy.indexOf('socket_packages:');
    const nextPolicy = policy.indexOf('\n  #', socketStart + 1);
    const socketBlock = policy.slice(socketStart, nextPolicy > 0 ? nextPolicy : undefined);
    expect(socketBlock).toContain('/usr/bin/npm');
    expect(socketBlock).toContain('/usr/bin/node');
  });
});

describe('setup.sh Socket.dev integration', () => {
  it('configures Socket.dev registry when SOCKET_TOKEN is present', () => {
    expect(setup).toContain('SOCKET_TOKEN');
    expect(setup).toContain('registry.socket.dev');
    expect(setup).toContain('_authToken');
  });

  it('uses a separate Openrind Shell-managed file, not the user .npmrc', () => {
    // Must NOT write to the user's .npmrc.
    expect(setup).not.toContain('/sandbox/.npmrc');
    // Must use a dedicated temporary file.
    expect(setup).toMatch(/openrind-shell-npmrc|OPENRIND_SHELL_NPMRC/);
    // Must set NPM_CONFIG_USERCONFIG to point npm at the managed file.
    expect(setup).toContain('NPM_CONFIG_USERCONFIG');
  });

  it('does not delete any user file under /sandbox', () => {
    expect(setup).not.toMatch(/rm.*\/sandbox\/\.(?:npmrc|claude|openeral)/);
  });

  it('does not hardcode the SOCKET_TOKEN value', () => {
    expect(setup).toContain('${SOCKET_TOKEN}');
    expect(setup).not.toMatch(/sock_[a-zA-Z0-9]/);
  });

  it('Socket.dev config is conditional (only when SOCKET_TOKEN is set)', () => {
    expect(setup).toMatch(/if \[ -n "\$\{SOCKET_TOKEN:-\}"/);
  });
});

describe('setup.sh Openrind Gateway integration', () => {
  it('normalizes presign URLs before writing Claude settings', () => {
    expect(setup).toContain('normalize_stringcost_proxy_url');
    expect(setup).toContain('url.pathname = url.pathname.replace(/\\/v1\\/.*$/, "");');
    expect(setup).toContain('s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL');
  });

  it('keeps Node warnings out of ANTHROPIC_BASE_URL', () => {
    expect(setup).toContain('export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"');
    expect(setup).toContain('NODE_NO_WARNINGS=1 node');
    expect(setup).toContain('2>"$STRINGCOST_PRESIGN_ERR"');
    expect(setup).not.toContain('2>&1)"');
  });

  it('extracts current and legacy gateway URLs from noisy presign output', () => {
    expect(setup).toContain('proxy\\.openrind\\.com\\/openrind-gateway-proxy');
    expect(setup).toContain('proxy\\.stringcost\\.com\\/stringcost-proxy');
    expect(setup).toContain('const candidate = match ? match[0] : raw;');
    expect(setup).toContain('const url = new URL(candidate);');
    expect(setup).toContain('normalize_stringcost_proxy_url_or_warn');
    expect(setup).toContain('setup.sh: ignoring invalid Openrind Gateway proxy URL from');
  });

  it('uses the renamed upload and keeps old presigns as a compatibility path', () => {
    expect(setup).toContain('/sandbox/openrind-shell-input/presign.json');
    expect(setup).toContain('/sandbox/openeral-input/presign.json');
    expect(setup).toContain('setup.sh: using uploaded Openrind Gateway presign');
    expect(setup).not.toContain('skipping StringCost presign creation because ANTHROPIC_API_KEY is an OpenShell placeholder');
  });

  it('supports legacy bundled upload inputs', () => {
    expect(setup).toContain('/sandbox/openeral-input/db-url');
    expect(setup).toContain('find /sandbox/openeral-input -type f -name db-url');
  });

  it('exports ANTHROPIC_BASE_URL through the session env consumed by Claude', () => {
    // Claude Code reads these from process.env at startup for auth-mode
    // selection; settings.json alone isn't consulted in time.  Without the
    // exported env var, the fallback URL in settings.json wins and produces
    // doubled /v1/messages paths against StringCost.
    expect(setup).toContain('write_export ANTHROPIC_BASE_URL "$STRINGCOST_PROXY_URL"');
    expect(claudeWrapper).toContain('. /tmp/openrind-shell-session.env');
    expect(claudeWrapper).not.toMatch(/unset ANTHROPIC_API_KEY/);
    expect(claudeWrapper).toMatch(/unset STRINGCOST_API_KEY/);
    expect(claudeWrapper).toMatch(/unset OPENRIND_GATEWAY_API_KEY/);
    expect(claudeWrapper).toMatch(/unset ANTHROPIC_AUTH_TOKEN/);
  });

  it('does not persist API keys in Claude settings', () => {
    expect(setup).toContain('delete s.env.ANTHROPIC_API_KEY');
    expect(setup).toContain('delete s.env.ANTHROPIC_AUTH_TOKEN');
    expect(claudeWrapper).not.toMatch(/write.*ANTHROPIC_API_KEY/);
    expect(setup).not.toContain('write_export ANTHROPIC_API_KEY');
  });

  it('leaves direct-auth credentials to per-process OpenShell injection', () => {
    expect(setup).not.toContain('write_export ANTHROPIC_API_KEY');
    expect(claudeWrapper).not.toMatch(/unset ANTHROPIC_API_KEY/);
  });

  it('does not fabricate or persist an Anthropic placeholder', () => {
    expect(setup).not.toContain('write_export ANTHROPIC_API_KEY');
    expect(setup).not.toContain('write_export ANTHROPIC_AUTH_TOKEN');
  });

  it('CLI starts the sandbox wrapper through sandbox exec', () => {
    expect(cli).toContain('openrind-shell-init');
    expect(cli).toMatch(/'sandbox',\s*'exec'/);
    expect(cli).toContain("'claude', ...claudeArgs");
    expect(cli).not.toMatch(/-u ANTHROPIC_API_KEY/);
  });
});
