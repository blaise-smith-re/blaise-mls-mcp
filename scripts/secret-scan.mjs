#!/usr/bin/env node
/**
 * Repository secret scan. Fails the build if anything credential-shaped is
 * committed. Runs over git-tracked files only, so it reflects exactly what
 * would be pushed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SKIP_FILES = new Set(['package-lock.json', 'scripts/secret-scan.mjs']);
const SKIP_DIRS = ['node_modules/', 'dist/', 'coverage/'];

/**
 * A line carrying this marker is skipped. Reserved for code that deliberately
 * contains credential-shaped text — chiefly the tests that prove redaction
 * works, which cannot do their job without a token-shaped literal. Every use is
 * visible in the diff and should be justified in review.
 */
const ALLOW_MARKER = 'secret-scan:allow';

/**
 * A real leaked credential in a source file is a quoted string literal. An
 * unquoted value in source is code — a schema declaration (`z.string()`), a
 * property reference, or an identifier naming a constant — so quoting is what
 * separates a leak from a mention. In dotenv-style files there are no quotes,
 * so a bare value counts.
 */
const isDotenvFile = (file) => {
  const base = file.split('/').pop() ?? '';
  // Covers .env, .env.production, and also local.env / secrets.env.
  return /^\.env(\.|$)/.test(base) || /\.env$/.test(base);
};

const RULES = [
  {
    name: 'assigned-secret-env-var',
    // A secret-shaped env var assigned a non-empty, non-placeholder value.
    pattern: /\b(MLSGRID_TOKEN|MCP_AUTH_TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|ACCESS_TOKEN)\s*[=:]\s*(["']?)([^\s"',}]+)/gi,
    isViolation: (m, file) => {
      const quoted = m[2] !== '';
      const value = m[3] ?? '';
      if (value.length < 8) return false;
      if (!quoted && !isDotenvFile(file)) return false;
      // Allow documentation placeholders and interpolated references.
      return !/^(<|\$|\{|process\.|env\.|your|placeholder|redacted|example|changeme|\.\.\.)/i.test(value);
    }
  },
  {
    name: 'bearer-literal',
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    isViolation: (m) => !/\$\{|REDACTED|<|token\b/i.test(m[0])
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    isViolation: () => true
  },
  {
    name: 'aws-access-key-id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    isViolation: () => true
  },
  {
    name: 'dotenv-file-committed',
    pattern: /^$/,
    isViolation: () => false
  }
];

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const files = trackedFiles();
const findings = [];

// A committed dotenv file is itself a finding, regardless of content.
// .env.example is the one intended exception: it holds placeholders only.
for (const file of files) {
  const base = file.split('/').pop() ?? '';
  if (isDotenvFile(file) && base !== '.env.example') {
    findings.push({ file, rule: 'dotenv-file-committed', line: 0, excerpt: file });
  }
}

for (const file of files) {
  if (SKIP_FILES.has(file)) continue;
  if (SKIP_DIRS.some((d) => file.startsWith(d))) continue;
  let stats;
  try {
    stats = statSync(file);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > 2_000_000) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\u0000')) continue; // skip binary files

  const lines = content.split('\n');
  for (const rule of RULES) {
    if (rule.name === 'dotenv-file-committed') continue;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // The marker may sit on the offending line or the one immediately above it.
      if (line.includes(ALLOW_MARKER) || (i > 0 && lines[i - 1].includes(ALLOW_MARKER))) continue;
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        if (!rule.isViolation(match, file)) continue;
        findings.push({
          file,
          rule: rule.name,
          line: i + 1,
          excerpt: line.trim().slice(0, 120)
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`SECRET SCAN: FAIL — ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} [${f.rule}]`);
    console.error(`    ${f.excerpt}`);
  }
  process.exit(1);
}

console.log(`SECRET SCAN: PASS — ${files.length} tracked file(s) scanned, 0 findings.`);
