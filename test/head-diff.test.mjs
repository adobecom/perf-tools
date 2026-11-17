import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyHeadDiff, headMatchesBase } from '../lib/pagespeed/head-diff.mjs';
import { checkoutPrSources, documentSourceKind, resolvePullRequests } from '../lib/pagespeed/pr-sources.mjs';

const BASE = `<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://a.example" crossorigin>
<script src="/scripts.js" type="module"></script>
<script>
  window.x = { a: 1 };
</script>
`;
// What AEM serves: void tags re-serialized, head.html placed after the generated metadata.
const DOC = `<!DOCTYPE html><html><head>
    <title>T</title>
    <meta name="description" content="a &#x26; b">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="preconnect" href="https://a.example" crossorigin="">
    <script src="/scripts.js" type="module"></script>
    <script>
  window.x = { a: 1 };
</script>
  </head><body></body></html>`;
const EARLY = '<script>\n  import("/early.js");\n</script>';

test('head.html PR diff: an appended element is added to the production head after its anchor', () => {
  assert.equal(headMatchesBase(DOC, BASE), true);
  const out = applyHeadDiff(DOC, BASE, `${BASE}${EARLY}\n`);
  assert.deepEqual([out.added, out.removed], [1, 0]);
  assert.match(out.html, /window\.x = \{ a: 1 \};\n<\/script>\n    <script>\n  import\("\/early\.js"\);\n<\/script>\n  <\/head>/);
  assert.equal(out.html.replace(/\n    <script>\n  import[^]*?<\/script>(?=\n  <\/head>)/, ''), DOC);
});

test('head.html PR diff: removed and changed elements are applied, prepended ones go before the first kept element', () => {
  const head = BASE.replace('<link rel="preconnect" href="https://a.example" crossorigin>\n', '').replace('{ a: 1 }', '{ a: 2 }');
  const removedAndChanged = applyHeadDiff(DOC, BASE, head);
  assert.deepEqual([removedAndChanged.added, removedAndChanged.removed], [1, 2]);
  assert.doesNotMatch(removedAndChanged.html, /preconnect/);
  assert.match(removedAndChanged.html, /a: 2/);
  const prepended = applyHeadDiff(DOC, BASE, `<meta name="x" content="1">\n${BASE}`);
  assert.ok(prepended.html.indexOf('name="x"') < prepended.html.indexOf('name="viewport"'));
});

test('head.html PR diff is guarded: production head.html drift or an ambiguous anchor stops the job', () => {
  const drifted = DOC.replace('{ a: 1 }', '{ a: 9 }');
  assert.equal(headMatchesBase(drifted, BASE), false);
  assert.throws(() => applyHeadDiff(drifted, BASE, `${BASE}${EARLY}`), (e) => e.fatal && /occurs 0 times/.test(e.message));
  const duplicated = DOC.replace('</head>', '<script>\n  window.x = { a: 1 };\n</script></head>');
  assert.throws(() => applyHeadDiff(duplicated, BASE, `${BASE}${EARLY}`), (e) => e.fatal && /occurs 2 times/.test(e.message));
  assert.throws(() => applyHeadDiff(DOC, BASE, BASE), /no element-level change/);
});

test('da-dc PRs map repo files to the same path; head.html is a document source and carries its merge-base content', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ab-dadc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--initial-branch=stage');
  git('config', 'user.email', 'perf-test@example.invalid');
  git('config', 'user.name', 'perf test');
  fs.mkdirSync(path.join(root, 'acrobat'));
  fs.writeFileSync(path.join(root, 'head.html'), BASE);
  fs.writeFileSync(path.join(root, 'acrobat/scripts.js'), 'old\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'head.html'), `${BASE}${EARLY}\n`);
  fs.writeFileSync(path.join(root, 'acrobat/scripts.js'), 'new\n');
  fs.mkdirSync(path.join(root, '.github'));
  fs.writeFileSync(path.join(root, '.github/ci.yml'), 'x\n');
  git('add', '.');
  git('commit', '-m', 'head');
  const headSha = git('rev-parse', 'HEAD');
  const blob = (f) => git('rev-parse', `${headSha}:${f}`);
  const files = [
    { filename: 'head.html', status: 'modified', sha: blob('head.html') },
    { filename: 'acrobat/scripts.js', status: 'modified', sha: blob('acrobat/scripts.js') },
    { filename: '.github/ci.yml', status: 'added', sha: blob('.github/ci.yml') },
  ];
  const repo = 'adobecom/da-dc';
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === `/repos/${repo}/pulls/320`) return Response.json({ number: 320, base: { ref: 'stage', sha: baseSha, repo: { full_name: repo } }, head: { ref: 'b', sha: headSha, repo: { full_name: repo } } });
    return Response.json({ merge_base_commit: { sha: baseSha }, files });
  };
  const resolved = await resolvePullRequests([{ repo, number: 320 }], { fetchImpl });
  assert.deepEqual(Object.keys(resolved.localSources).sort(), ['/acrobat/scripts.js', '/head.html']);
  assert.equal(documentSourceKind(repo, '/head.html'), 'head');
  assert.equal(documentSourceKind(repo, '/acrobat/scripts.js'), null);
  const checkout = checkoutPrSources(resolved.localSources, { repositoryUrl: () => `file://${root}`, allowFileProtocol: true });
  t.after(checkout.cleanup);
  assert.equal(checkout.contents.get('/head.html').baseBody.toString(), BASE);
  assert.equal(checkout.contents.get('/head.html').body.toString(), `${BASE}${EARLY}\n`);
  assert.equal(checkout.contents.get('/acrobat/scripts.js').body.toString(), 'new\n');
});
