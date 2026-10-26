// Builds the hook for this machine into bin/<platform>-<arch>/, where the extension looks for
// it. Releases build every platform in CI instead (.github/workflows/release.yml).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
try {
  execFileSync('cargo', ['build', '--release', '--manifest-path', path.join(root, 'hook', 'Cargo.toml')], {
    stdio: 'inherit',
  });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('Building the hook needs Rust (https://rustup.rs), or install a release .vsix instead.');
  }
  process.exit(1);
}
const dir = path.join(root, 'bin', `${process.platform}-${process.arch}`);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(path.join(root, 'hook', 'target', 'release', 'spool-hook'), path.join(dir, 'spool-hook'));
fs.chmodSync(path.join(dir, 'spool-hook'), 0o755);
console.log(`built ${path.relative(root, path.join(dir, 'spool-hook'))}`);
