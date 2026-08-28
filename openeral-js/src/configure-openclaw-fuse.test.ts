import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const configuratorPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../sandboxes/openeral/configure-openclaw-fuse.mjs',
);
const configuratorSource = readFileSync(configuratorPath, 'utf8');
const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const testGlobal = globalThis as typeof globalThis & { __openrindTestJson5?: typeof JSON5 };

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  delete testGlobal.__openrindTestJson5;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'openrind-openclaw-config-'));
  tempDirs.push(root);
  return join(root, name);
}

function configPath(home: string): string {
  return join(home, '.openclaw', 'openclaw.json');
}

function invalidBackups(home: string): string[] {
  const directory = dirname(configPath(home));
  return readdirSync(directory).filter((name) => name.startsWith('openclaw.json.invalid-'));
}

async function runConfigurator(home: string): Promise<void> {
  const source = configuratorSource
    .replace('import JSON5 from "json5";', 'const JSON5 = globalThis.__openrindTestJson5;')
    .replace(
      'const OPENCLAW_HOME = "/sandbox/openclaw-home";',
      `const OPENCLAW_HOME = ${JSON.stringify(home)};`,
    );

  testGlobal.__openrindTestJson5 = JSON5;
  process.env.HOME = home;
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

describe('OpenClaw FUSE configurator', () => {
  it('preserves syntax accepted by OpenClaw without creating an invalid backup', async () => {
    const home = makeHome('valid');
    const path = configPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{
      // JSON5 features that the old regex normalizer rejected.
      custom: {
        singleQuoted: 'kept',
        hexadecimal: 0x2a,
        leadingDecimal: .5,
        trailingDecimal: 5.,
        plusNumber: +7,
      },
    }`);

    await runConfigurator(home);

    const configured = JSON.parse(readFileSync(path, 'utf8'));
    expect(configured.custom).toEqual({
      singleQuoted: 'kept',
      hexadecimal: 42,
      leadingDecimal: 0.5,
      trailingDecimal: 5,
      plusNumber: 7,
    });
    expect(invalidBackups(home)).toEqual([]);
  });

  it('backs up genuinely invalid input before writing a replacement', async () => {
    const home = makeHome('invalid');
    const path = configPath(home);
    const invalid = '{ broken:';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, invalid);

    await runConfigurator(home);

    const backups = invalidBackups(home);
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(path), backups[0]), 'utf8')).toBe(invalid);
    expect(existsSync(path)).toBe(true);
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });
});
