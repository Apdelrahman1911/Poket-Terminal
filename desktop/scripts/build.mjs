import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, '.runtime/candidates/client'));
if (!output.startsWith(path.join(root, '.runtime/'))) throw new Error('Build only isolated PocketDesktop candidates');
if (fs.existsSync(path.join(output, 'FROZEN.json'))) throw new Error('Refuse to overwrite frozen candidate');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const source = path.join(output, 'source');
fs.rmSync(source, { recursive: true, force: true });
fs.mkdirSync(path.join(source, 'vendor'), { recursive: true });
fs.cpSync(path.join(root, 'client'), path.join(source, 'client'), { recursive: true });
fs.cpSync(path.join(root, 'patches'), path.join(source, 'patches'), { recursive: true });
const vendor = path.join(source, 'vendor/novnc');
fs.cpSync(path.join(root, 'node_modules/@novnc/novnc'), vendor, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(vendor, 'package.json')));
if (pkg.version !== '1.7.0') throw new Error('Unexpected noVNC version');
const original = JSON.parse(fs.readFileSync(path.join(root, 'patches/upstream-sha256.json')));
for (const [file, digest] of Object.entries(original)) {
  if (createHash('sha256').update(fs.readFileSync(path.join(vendor, file))).digest('hex') !== digest) throw new Error('Upstream source changed: ' + file);
}
execFileSync('patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(root, 'patches/novnc-1.7.0.patch')], { cwd: vendor, stdio: 'pipe' });
const dist = path.join(output, 'client'); fs.mkdirSync(dist, { recursive: true });
const result = await build({ entryPoints: [path.join(source, 'client/main.js')], outfile: path.join(dist, 'desktop.js'), bundle: true,
  format: 'esm', target: ['es2022'], minify: true, sourcemap: false, legalComments: 'eof', metafile: true });
for (const file of ['index.html', 'desktop.css']) fs.copyFileSync(path.join(root, 'client', file), path.join(dist, file));
const licenses = ['PocketDesktop modifications to noVNC 1.7.0 are under MPL-2.0.\nCorresponding patched source and patch accompany this client in the candidate source/ tree; retain and provide them with redistribution.\n'];
for (const file of ['LICENSE.txt', 'AUTHORS', ...fs.readdirSync(path.join(vendor, 'docs')).filter(f => f.startsWith('LICENSE')).map(f => 'docs/' + f)]) licenses.push(`\n--- noVNC ${file} ---\n${fs.readFileSync(path.join(vendor, file), 'utf8')}`);
const pako = path.join(vendor, 'vendor/pako/LICENSE');
if (fs.existsSync(pako)) licenses.push('\n--- pako ---\n' + fs.readFileSync(pako, 'utf8'));
fs.writeFileSync(path.join(dist, 'LICENSES.txt'), licenses.join('\n'));
fs.writeFileSync(path.join(output, 'metafile.json'), JSON.stringify(result.metafile, null, 2));
const hashes = Object.fromEntries(fs.readdirSync(dist).sort().map(file => [file, { bytes: fs.statSync(path.join(dist, file)).size, sha256: createHash('sha256').update(fs.readFileSync(path.join(dist, file))).digest('hex') }]));
fs.writeFileSync(path.join(output, 'artifacts.json'), JSON.stringify({ noVNC: pkg.version, original, hashes }, null, 2) + '\n');
console.log(JSON.stringify({ output, files: hashes }, null, 2));
