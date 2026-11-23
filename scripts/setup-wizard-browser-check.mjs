// Headless Edge/Chrome check of the setup wizard, against a THROWAWAY deck it starts itself:
//   node scripts/setup-wizard-browser-check.mjs [screenshot-dir]
// Everything is temp: HOME, state file, working folder (with two project folders and a CLAUDE.md of its own), docs folder,
// a fixture template (DEKKI_TEMPLATE) and a stub `claude` on PATH. No real account, agent or folder is touched, and the
// Finder chooser is never opened. Walks all four screens in dark and in light, the existing-CLAUDE.md notice, the docs-folder
// refusals, the Esc confirm, the palette entries and the health result. Screenshots go to <screenshot-dir> (default: a temp
// folder); their paths are printed. Browser: DECK_TEST_BROWSER (default Microsoft Edge on macOS).
import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4393;
const CDP = 9348;
const BIN = process.env.DECK_TEST_BROWSER || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-setup-check-')));
const shotDir = process.argv[2] || path.join(tmp, 'shots');
const home = path.join(tmp, 'home');
const work = path.join(home, 'Projects'); // the wizard suggests the first existing of ~/Projects, ~/Developer, ...
const docs = path.join(tmp, 'notes', 'project-docs'); // does not exist: the wizard offers to create it
for (const d of [path.join(work, 'app', '.git'), path.join(work, 'site'), path.join(tmp, 'bin'), path.join(tmp, 'prompts'), path.join(tmp, 'cfg')]) fs.mkdirSync(d, { recursive: true });
const OWN = '# My own playbook\n\nRules that are mine.\n';
fs.writeFileSync(path.join(work, 'CLAUDE.md'), OWN);
fs.writeFileSync(path.join(tmp, 'bin', 'claude'), '#!/bin/sh\nif [ "$1" = agents ]; then echo "[]"; fi\n', { mode: 0o755 });
fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ root: '', accounts: [], activeAccount: 'default' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
const deck = spawn(process.execPath, ['server/start.js'], {
  cwd: REPO,
  env: {
    ...process.env, PORT: String(PORT), HOME: home, DEKKI_STATE: path.join(tmp, 'state.json'), DEKKI_PROMPTS: path.join(tmp, 'prompts'),
    DEKKI_PROJECTS_DIR: path.join(tmp, 'none'), DEKKI_TEMPLATE: path.join(REPO, 'server/test/fixtures/setup-template'),
    PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
  },
  stdio: 'ignore',
});
const profile = path.join(tmp, 'profile');
const browser = spawn(BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 120; i++) {
    try { const t = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const pg = t.find((x) => x.type === 'page'); if (pg) return pg.webSocketDebuggerUrl; if (t.length && i > 8) return (await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json()).webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('browser did not start');
}

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(250); } }
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.on('open', r));
  let n = 0;
  const pending = new Map();
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) pending.get(d.id)(d); });
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const shot = async (name) => { fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); const f = path.join(shotDir, name); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); console.log(`shot ${f}`); };
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  const dialog = () => text('.dialog.wizard');
  const allDialogs = () => ev(`[...document.querySelectorAll('.dialog')].map((d)=>d.innerText).join('\\n---\\n')`);
  const btnExpr = (label) => `[...document.querySelectorAll('.dialog button')].find((x)=>x.innerText.trim().startsWith(${JSON.stringify(label)}))`;
  const click = (expr) => ev(`(()=>{const b=${expr};if(b)b.click();return !!b})()`);
  const press = (label) => click(btnExpr(label));
  const typeIn = (label, v) => ev(`(()=>{const l=[...document.querySelectorAll('.dialog label')].find((x)=>x.innerText.trim().startsWith(${JSON.stringify(label)}));const i=l&&l.querySelector('input[type=text]');if(!i)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const inputValue = (label) => ev(`[...document.querySelectorAll('.dialog label')].find((x)=>x.innerText.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input[type=text]')?.value ?? null`);
  const tick = (label) => ev(`(()=>{const l=[...document.querySelectorAll('.dialog label')].find((x)=>x.innerText.includes(${JSON.stringify(label)}));const c=l&&l.querySelector('input[type=checkbox]');if(c)c.click();return !!c})()`);
  const esc = () => ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  const isMac = await ev(`/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)`);
  const palette = async (query) => {
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:${isMac},ctrlKey:${!isMac},bubbles:true,cancelable:true}))`);
    await sleep(400);
    await ev(`(()=>{const i=document.querySelector('.pal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(query)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await sleep(300);
    await ev(`document.querySelector('.pal input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await sleep(900);
  };
  const setTheme = async (t) => { await ev(`localStorage.setItem('dekki.theme', ${JSON.stringify(t)})`); await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }); await sleep(2200); };
  const theme = () => ev(`document.documentElement.dataset.theme`);
  const checked = (name) => ev(`document.querySelector('.dialog input[name=${name}]:checked')?.value ?? null`);

  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });

  // ------------------------------------------------------------------ pass 1, dark: the whole walk
  await setTheme('dark');
  ok((await theme()) === 'dark', 'theme: dark');
  ok((await text('.setup-callout')).includes('Set up your manager folder'), 'Home: a callout offers Set up while there is no working folder');
  await shot('01-home-callout-dark.png');
  await click(`document.querySelector('.setup-callout button')`);
  await sleep(1200);
  let d = await dialog();
  ok(d.includes('Set up') && ['Folders', 'Preferences', 'Safety', 'Review and create'].every((s) => d.includes(s)), 'wizard opens with the four screens in the progress bar');
  ok(await ev(`document.querySelector('.wiz-step.now .t')?.innerText`) === 'Folders' && await ev(`document.querySelector('.wiz-step.now')?.getAttribute('aria-current')`) === 'step', 'progress: Folders is the current step');
  ok(d.includes('DEKKI_DEMO=1'), 'screen 1: the demo-mode hint is there');
  ok((await inputValue('Working folder')) === work, 'screen 1: working folder prefilled from ~/Projects');
  ok((await inputValue('Docs folder')) === '', 'screen 1: the docs folder has no default');
  ok(d.includes('app') && d.includes('site') && d.includes('1 is a git repo'), 'screen 1: repos found are shown (1 git repo of 2 folders)');
  ok(await ev(`document.activeElement?.closest('label')?.innerText.startsWith('Working folder')`), 'focus starts in the first field');
  await shot('02-folders-dark.png');

  await press('Next');
  await sleep(500);
  ok((await dialog()).includes('Choose a docs folder'), 'screen 1: Next without a docs folder says so');
  await typeIn('Docs folder', path.join(work, 'docs'));
  await sleep(900);
  ok((await dialog()).includes('inside the working folder'), 'screen 1: a docs folder inside the working folder is refused');
  await shot('03-folders-refused-dark.png');
  await typeIn('Docs folder', work);
  await sleep(900);
  ok((await dialog()).includes('cannot be the working folder'), 'screen 1: the working folder itself is refused');
  await typeIn('Docs folder', path.dirname(work));
  await sleep(900);
  ok((await dialog()).includes('cannot contain the working folder'), 'screen 1: a folder that contains the working folder is refused');
  await typeIn('Docs folder', docs);
  await sleep(900);
  ok((await dialog()).includes('does not exist yet') && (await dialog()).includes('Create it'), 'screen 1: a missing docs folder offers "Create it"');
  await press('Next');
  await sleep(500);
  ok((await dialog()).includes('Tick “Create it”') && (await text('.wiz-step.now .t')) === 'Folders', 'screen 1: Next stays until Create it is ticked');
  await tick('Create it');
  await sleep(300);
  await press('Next');
  await sleep(700);

  d = await dialog();
  ok((await text('.wiz-step.now .t')) === 'Preferences', 'screen 2: Preferences');
  ok((await checked('pref-replyStyle')) === 'short' && (await checked('pref-autonomy')) === 'outward' && (await checked('pref-prs')) === 'me' && (await checked('pref-language')) === 'same', 'screen 2: defaults are selected');
  ok(JSON.stringify(await ev(`[...document.querySelectorAll('.wiz-chip')].map((c)=>c.innerText.replace('×','').trim())`)) === JSON.stringify(['main', 'master', 'develop']), 'screen 2: protected branches main, master, develop');
  ok(d.includes('Skip (use defaults)'), 'screen 2: Skip is offered');
  await ev(`document.querySelector('.dialog button[aria-label="Remove develop"]').click()`);
  await ev(`(()=>{const i=document.querySelector('.wiz-chip-in');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'release/1');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()`);
  await sleep(300);
  ok(JSON.stringify(await ev(`[...document.querySelectorAll('.wiz-chip')].map((c)=>c.innerText.replace('×','').trim())`)) === JSON.stringify(['main', 'master', 'release/1']), 'screen 2: a chip can be removed and one added with Enter (no form submit)');
  ok((await text('.wiz-step.now .t')) === 'Preferences', 'screen 2: Enter in the chip input did not move on');
  await ev(`document.querySelector('.dialog input[name=pref-replyStyle][value=detailed]').click()`);
  await shot('04-preferences-dark.png');
  await press('Next');
  await sleep(500);

  ok((await text('.wiz-step.now .t')) === 'Safety', 'screen 3: Safety');
  await typeIn('What must never be touched', 'production and billing');
  await shot('05-safety-dark.png');
  await press('Next');
  await sleep(1200);

  d = await dialog();
  ok((await text('.wiz-step.now .t')) === 'Review and create', 'screen 4: Review and create');
  ok(d.includes('CLAUDE.md') && d.includes('harness.json') && d.includes(`${docs}/README.md`) && d.includes('Create'), 'screen 4: the file list names the files and the docs README');
  ok(d.includes('Your CLAUDE.md is left as is.') && d.includes('Add the setup blocks to the end'), 'screen 4: heads-up for an existing CLAUDE.md without markers');
  ok(await ev(`document.querySelector('.wiz-notice input[type=checkbox]')?.checked === false`), 'screen 4: the append option is unticked');
  ok((await text('.wiz-copy pre')).includes('<!-- setup:preferences:start -->') && d.includes('Copy'), 'screen 4: the block text is in a copyable box');
  ok(d.includes('Left alone') || d.includes('left alone'), 'screen 4: existing CLAUDE.md is listed as left alone');
  await shot('06-review-dark.png');
  await press('Create');
  await sleep(2500);
  d = await dialog();
  ok(d.includes('Created') && d.includes('Manager playbook') && d.includes('delegate.sh --check passes'), 'screen 4: created, then the health result');
  ok(await ev(`document.querySelectorAll('.wiz-mark.gr').length`) >= 6 && await ev(`document.querySelectorAll('.wiz-mark.rd').length`) === 0, 'health: green ticks, no failures');
  await shot('07-health-dark.png');
  const trustCheck = async (theme) => {
    const t = await text('.wiz-trust');
    ok(t.toLowerCase().includes('trust these folders once') && t.includes('Run each once, accept the trust prompt, then /exit.'), `${theme}: the result screen has the "Trust these folders once" block with one sentence`);
    const cmds = await ev(`[...document.querySelectorAll('.wiz-trust pre')].map((p)=>p.innerText.trim())`);
    ok(JSON.stringify(cmds) === JSON.stringify([`cd "${docs}" && claude`, `cd "${path.join(work, 'app')}" && claude`]), `${theme}: commands for the docs folder and the git repo only (the plain folder "site" is not listed)`);
    ok((await ev(`document.querySelectorAll('.wiz-trust .wiz-copy button').length`)) === 2 && (await ev(`[...document.querySelectorAll('.wiz-trust .wiz-copy button')].every((b)=>b.innerText.trim()==='Copy')`)), `${theme}: each command has a Copy button`);
    ok(await ev(`[...document.querySelectorAll('.wiz-trust pre')].every((p)=>p.scrollWidth<=p.clientWidth+1)`), `${theme}: the commands fit their boxes`);
    ok(await ev(`!!document.querySelector('.wiz-trust ~ .wiz-health, .wiz-trust + .wiz-health')`) && (await ev(`[...document.querySelectorAll('.wiz-hi.st-info .wiz-hl')].some((l)=>l.innerText.includes('Folders trusted once'))`)), `${theme}: the health list has the non-failing trust note`);
    ok(await ev(`(()=>{const m=[...document.querySelectorAll('.wiz-hi.st-info')].find((x)=>x.innerText.includes('Folders trusted once'));return !!m && !m.querySelector('.wiz-fix')})()`), `${theme}: the trust note is a note, not a problem`);
    await ev(`document.querySelector('.wiz-trust').scrollIntoView({block:'center'})`);
    await sleep(200);
  };
  await trustCheck('dark');
  await shot('07b-trust-dark.png');
  ok(fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8') === OWN, 'disk: the existing CLAUDE.md is untouched');
  const cfg = JSON.parse(fs.readFileSync(path.join(work, '.claude/harness.json'), 'utf8'));
  ok(cfg.docsDir === docs && cfg.neverTouch === 'production and billing' && cfg.preferences.replyStyle === 'detailed' && JSON.stringify(cfg.protectedBranches) === '["main","master","release/1"]', 'disk: harness.json holds the answers');
  ok(fs.existsSync(path.join(docs, 'README.md')) && fs.existsSync(path.join(work, '.claude/harness.manifest.json')), 'disk: docs folder created with README, manifest written');
  ok(JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8')).root === work, 'state: the working folder was saved');
  await press('Done');
  await sleep(500);
  ok(!(await dialog()), 'Done closes the wizard');

  // ------------------------------------------------------------------ palette entries, Esc confirm
  await palette('Check setup');
  d = await dialog();
  ok(d.includes('Check setup') && d.includes('Manager playbook'), 'palette: "Check setup" shows the health check');
  await esc();
  await sleep(400);
  ok(!(await dialog()), 'Esc closes the check');
  await palette('Set up');
  ok((await dialog()).includes('Folders'), 'palette: "Set up" opens the wizard');
  ok((await inputValue('Docs folder')) === docs && (await inputValue('Working folder')) === work, 'wizard re-run: saved answers are prefilled');
  await esc();
  await sleep(400);
  ok(!(await dialog()), 'Esc closes at once when nothing was typed');
  await palette('Set up');
  await typeIn('Docs folder', `${docs}-other`);
  await sleep(200);
  await esc();
  await sleep(400);
  ok((await allDialogs()).includes('Close setup?') && !!(await dialog()), 'Esc asks before closing when something was typed');
  await shot('08-esc-confirm-dark.png');
  await esc();
  await sleep(400);
  ok(!(await allDialogs()).includes('Close setup?') && !!(await dialog()), 'a second Esc closes only the confirm; the wizard stays');
  await esc();
  await sleep(300);
  await press('Close');
  await sleep(500);
  ok(!(await dialog()), 'Close in the confirm closes the wizard');

  // ------------------------------------------------------------------ pass 2, light: re-run, tick the append option
  await setTheme('light');
  ok((await theme()) === 'light', 'theme: light');
  await click(`[...document.querySelectorAll('button')].find((b)=>b.innerText.trim()==='Setup')`);
  await sleep(1000);
  await shot('09-folders-light.png');
  ok((await dialog()).includes('Folders') && (await inputValue('Docs folder')) === docs, 'light: wizard opens from the Home Setup link, prefilled');
  await press('Next');
  await sleep(900);
  await shot('10-preferences-light.png');
  ok((await checked('pref-replyStyle')) === 'detailed', 'light: saved preference shown');
  await press('Skip');
  await sleep(500);
  await shot('11-safety-light.png');
  ok((await text('.wiz-step.now .t')) === 'Safety' && (await inputValue('What must never be touched')) === 'production and billing', 'light: Skip on Preferences moved on and left Safety alone');
  await press('Skip');
  await sleep(1200);
  d = await dialog();
  ok(d.includes('Review and create') && d.includes('Your CLAUDE.md is left as is.'), 'light: review shows the heads-up again');
  await tick('Add the setup blocks to the end');
  await sleep(900);
  ok((await dialog()).includes('Setup blocks added at the end'), 'light: ticking the option changes the CLAUDE.md row');
  await shot('12-review-light.png');
  await press('Create');
  await sleep(2500);
  await shot('13-health-light.png');
  await trustCheck('light');
  await shot('13b-trust-light.png');
  const md = fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  ok(md.startsWith(OWN) && md.includes('<!-- setup:docs:start -->') && md.includes(`${docs}`), 'disk: the blocks were appended after the unchanged original text');
  const cfg2 = JSON.parse(fs.readFileSync(path.join(work, '.claude/harness.json'), 'utf8'));
  ok(cfg2.neverTouch === null && cfg2.preferences.replyStyle === 'short', 'disk: Skip put the defaults back');
  await press('Done');
  await sleep(500);

  // ------------------------------------------------------------------ pass 3: CLAUDE.md now has markers but no manifest entry
  // (it was appended to, so it is not ours): the template differs, so the blocks are refreshed and CLAUDE.md.new is written.
  const SENTENCE = 'Your CLAUDE.md has your edits, so the new playbook text was saved as CLAUDE.md.new. Compare the two and copy over what you want.';
  const newCheck = async (theme) => {
    const t = await text('.wiz-result');
    ok(t.includes(SENTENCE), `${theme}: the result screen says the new playbook text was saved as CLAUDE.md.new`);
    ok(await ev(`(()=>{const r=document.querySelector('.wiz-result');return !!r && r.scrollWidth<=r.clientWidth+1})()`), `${theme}: the sentence fits its box`);
    await ev(`document.querySelector('.wiz-result').scrollIntoView({block:'center'})`);
    await sleep(200);
  };
  const rerun = async () => {
    await palette('Set up');
    await sleep(600);
    await press('Next'); await sleep(800);
    await press('Skip'); await sleep(500);
    await press('Skip'); await sleep(1200);
  };
  const before = fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  await rerun();
  ok(/left alone/.test(await dialog()) && (await dialog()).includes('CLAUDE.md.new'), 'light: the review row for CLAUDE.md says left alone and names CLAUDE.md.new');
  await press('Create');
  await sleep(2500);
  await newCheck('light');
  await shot('14-new-playbook-light.png');
  const after = fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  ok(after.startsWith(OWN) && after !== '', 'disk: CLAUDE.md keeps the user text');
  ok(fs.existsSync(path.join(work, 'CLAUDE.md.new')) && !fs.readFileSync(path.join(work, 'CLAUDE.md.new'), 'utf8').includes(OWN), 'disk: CLAUDE.md.new holds the template playbook, not the user text');
  ok(before.length > 0, 'disk: CLAUDE.md existed before the re-run');
  await press('Done');
  await sleep(500);
  await setTheme('dark');
  await rerun();
  await press('Create');
  await sleep(2500);
  await newCheck('dark');
  await shot('15-new-playbook-dark.png');
  await press('Done');
  ws.close();
} finally {
  browser.kill();
  deck.kill();
  if (!process.env.KEEP_TMP) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log(`screenshots: ${shotDir}`);
  if (!process.env.KEEP_TMP && !process.argv[2]) console.log('(set KEEP_TMP=1 to keep the temp folder, or pass a screenshot dir)');
  if (!process.env.KEEP_TMP && process.argv[2]) fs.rmSync(tmp, { recursive: true, force: true });
}
