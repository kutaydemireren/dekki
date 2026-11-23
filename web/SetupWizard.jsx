import React, { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { STEPS, PREF_ROWS, initialForm, buildRequest, isDirty, addBranches, removeBranch, foldersError, resetScreen, applyReuse, fileLabel, fileName, reviewCounts, claudeNotice, healthMark, wizardTitle, trustView, resultLines } from './setup-ui.js';

// Setup wizard: four screens (Folders, Preferences, Safety, Review and create) for the ACTIVE account, then the health check.
// mode "check" shows only the health check. The server does all validation and writing (server/setup.js); this file is the form.
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));
const get = (url) => fetch(url).then((r) => r.json());

function HealthList({ items }) {
  return (
    <ul className="wiz-health" aria-label="Health check">
      {items.map((i) => {
        const m = healthMark(i);
        return (
          <li key={i.id} className={`wiz-hi st-${i.status}`}>
            <span className={`wiz-mark ${m.tone}`} aria-hidden="true">{m.glyph}</span>
            <span className="wiz-hb">
              <span className="wiz-hl">{i.label}{i.status !== 'ok' && <span className="sr-only"> ({i.status === 'info' ? 'note' : 'problem'})</span>}</span>
              {i.detail && <span className="wiz-hd">{i.detail}</span>}
              {i.status === 'fail' && i.fix && <span className="wiz-fix">Fix: {i.fix}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CopyBox({ text, label = 'Setup blocks to copy', className = '' }) {
  const [done, setDone] = useState(false);
  const pre = useRef(null);
  async function copy() {
    try { await navigator.clipboard.writeText(text); } catch {
      const r = document.createRange(); r.selectNodeContents(pre.current);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      try { document.execCommand('copy'); } catch { /* the text stays selected for a manual copy */ }
    }
    setDone(true); setTimeout(() => setDone(false), 1500);
  }
  return (
    <div className={`wiz-copy ${className}`.trim()}>
      <pre ref={pre} tabIndex={0} aria-label={label}>{text}</pre>
      <button type="button" onClick={copy}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

// After Create: `claude --bg` refuses a folder that was never trusted, so each one is opened once in a terminal.
function TrustBlock({ trust }) {
  const v = trustView(trust);
  if (!v) return null;
  return (
    <section className="wiz-trust" aria-label={v.title}>
      <div className="wiz-list-h">{v.title}</div>
      <div className="hint">{v.text}</div>
      <ul className="wiz-trust-list">
        {v.rows.map((r) => (
          <li key={r.key}>
            <span className="wiz-trust-name">{r.label}</span>
            <CopyBox text={r.command} label={`Command for ${r.label}`} className="wiz-copy-line" />
          </li>
        ))}
      </ul>
      {v.more && <div className="hint">{v.more}</div>}
    </section>
  );
}

export default function SetupWizard({ mode = 'setup', onClose, onChanged, onSetup }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(null);
  const [initial, setInitial] = useState(null);
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState(null); // last answer of /preview: {ok:true,...} or {ok:false,error,field}
  const [candidate, setCandidate] = useState(null); // repos of the typed working folder
  const [result, setResult] = useState(null); // answer of /apply
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reuseId, setReuseId] = useState('');
  const [branchText, setBranchText] = useState(''); // the chip input of Protected branches
  const [loadErr, setLoadErr] = useState(null);
  const snap = useRef(null); // form before "reuse" was ticked
  const seq = useRef(0);
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setErr(null); };

  useEffect(() => {
    get('/api/setup').then((s) => {
      setStatus(s);
      const f = initialForm(s);
      setForm(f); setInitial(f);
    }).catch((e) => setLoadErr(e.message));
    if (mode === 'check') post('/api/setup/health').then((r) => (r.ok ? setHealth(r.body) : setErr(r.body.error || 'The check failed.')));
  }, [mode]);

  // The preview doubles as live validation of the folders; the review screen shows the same answer.
  async function runPreview(f = form) {
    const n = ++seq.current;
    const r = await post('/api/setup/preview', buildRequest(f));
    const v = r.ok ? r.body : { ok: false, error: r.body.error || 'Could not check the folders.', field: r.body.field };
    if (n === seq.current) setPreview(v);
    return v;
  }
  const key = form ? JSON.stringify(buildRequest(form)) : '';
  useEffect(() => {
    if (!form || mode === 'check' || result) return undefined;
    if (!form.root.trim() || !form.docsDir.trim()) { setPreview(null); return undefined; }
    const t = setTimeout(() => runPreview(), 350);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!form || mode === 'check') return undefined;
    if (!form.root.trim()) { setCandidate(null); return undefined; }
    const t = setTimeout(() => get(`/api/setup?root=${encodeURIComponent(form.root.trim())}`).then((s) => setCandidate(s.candidate || null)).catch(() => setCandidate(null)), 300);
    return () => clearTimeout(t);
  }, [form?.root, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !result && form && initial && (isDirty(form, initial) || branchText.trim() !== '');
  const requestClose = () => { if (dirty) setConfirmClose(true); else onClose(); };

  async function pick(url, field) {
    setErr(null);
    const r = await post(url);
    if (!r.ok) setErr(r.body.error || 'Could not open the folder chooser. Type the path instead.');
    else if (r.body.path) set({ [field]: r.body.path, ...(field === 'docsDir' ? { createDocsDir: false } : {}) });
  }

  async function next() {
    if (step === 0) {
      const e = foldersError(form);
      if (e) return setErr(e);
      setBusy(true);
      const r = await runPreview();
      setBusy(false);
      if (!r.ok) return setErr(r.error);
      if (r.docs.needsCreate && !form.createDocsDir) return setErr('The docs folder does not exist yet. Tick “Create it”, or choose an existing folder.');
    }
    setErr(null);
    if (step === 2) { setBusy(true); const r = await runPreview(); setBusy(false); if (!r.ok) return setErr(r.error); }
    setStep(step + 1);
  }
  const back = () => { setErr(null); setStep(Math.max(0, step - 1)); };
  const skip = () => { setForm((f) => resetScreen(f, step)); setReuseId(''); setErr(null); setStep(step + 1); };

  async function create() {
    setBusy(true); setErr(null);
    const r = await post('/api/setup/apply', buildRequest(form));
    setBusy(false);
    if (!r.ok) return setErr(r.body.error || 'Setup failed.');
    setResult(r.body); setHealth(r.body.health || null);
    onChanged && onChanged(r.body);
  }
  async function recheck() {
    setBusy(true); setErr(null);
    const r = await post('/api/setup/health');
    setBusy(false);
    if (!r.ok) return setErr(r.body.error || 'The check failed.');
    setHealth(r.body);
  }

  function toggleReuse(id) {
    if (!id) { if (snap.current) setForm(snap.current); snap.current = null; setReuseId(''); return; }
    if (!snap.current) snap.current = form;
    setForm((f) => applyReuse(f, status.reuse.find((x) => x.id === id)));
    setReuseId(id);
  }

  const title = wizardTitle(status, mode);
  if (loadErr || !form) {
    return (
      <Dialog title={title} top className="wizard" onClose={onClose} actions={<button type="button" onClick={onClose}>Close</button>}>
        {loadErr ? <div className="err">Could not load the setup: {loadErr}</div> : <div className="hint">Loading…</div>}
      </Dialog>
    );
  }

  // ---- check mode: only the health check
  if (mode === 'check') {
    return (
      <Dialog title={title} top className="wizard" onClose={onClose} actions={(
        <>
          {onSetup && <button type="button" onClick={onSetup}>Open Set up</button>}
          <button type="button" disabled={busy} onClick={recheck}>Check again</button>
          <button type="button" className="primary" onClick={onClose}>Close</button>
        </>
      )}>
        {health ? <HealthList items={health.items} /> : !err && <div className="hint">Checking…</div>}
        {health && health.ok && <div className="ok">Everything needed is in place.</div>}
        {err && <div className="err">{err}</div>}
      </Dialog>
    );
  }

  const pv = preview && preview.ok ? preview : null;
  const folderErr = (f) => (preview && !preview.ok && preview.field === f ? preview.error : null);
  const radio = (name, value, checked, onChange, label, hint, autoFocus) => (
    <label className="radio" key={value}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} autoFocus={autoFocus} />
      <span><b>{label}</b>{hint && <span className="hint">{hint}</span>}</span>
    </label>
  );
  const prefRow = (row, first) => (
    <fieldset className="wiz-row" key={row.key}>
      <legend>{row.label}</legend>
      {row.options.map((o, i) => radio(`pref-${row.key}`, o.value, form.preferences[row.key] === o.value, () => set({ preferences: { ...form.preferences, [row.key]: o.value } }), o.label, o.hint, first && i === 0))}
    </fieldset>
  );

  const addFromInput = () => {
    if (!branchText.trim()) return;
    const r = addBranches(form.protectedBranches, branchText);
    if (r.error) return setErr(r.error);
    setForm((f) => ({ ...f, protectedBranches: r.list })); setBranchText(''); setErr(null);
  };

  const notice = pv && claudeNotice(pv);
  const counts = pv ? reviewCounts(pv.files) : null;
  const rootFiles = pv ? pv.files.filter((f) => f.where === 'root') : [];
  const docFiles = pv ? pv.files.filter((f) => f.where === 'docs') : [];
  const fileRow = (f) => {
    const l = fileLabel(f);
    return (
      <li key={f.path} className="wiz-file">
        <code>{fileName(f, pv.docsDir)}</code>
        <span className={`chip ${l.tone}`}>{l.text}</span>
        {f.note && f.action !== 'create' && <span className="wiz-fn">{f.note}</span>}
      </li>
    );
  };

  const last = step === 3;
  const submit = (e) => { e.preventDefault(); if (busy) return; if (result) return; if (last) create(); else next(); };

  return (
    <>
      <Dialog title={title} top className="wizard" onClose={requestClose} onSubmit={submit} actions={(
        result ? (
          <>
            <button type="button" disabled={busy} onClick={recheck}>Check again</button>
            <button type="button" className="primary" autoFocus onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            {step === 0 && <button type="button" onClick={requestClose}>Cancel</button>}
            {step > 0 && <button type="button" onClick={back}>Back</button>}
            {(step === 1 || step === 2) && <button type="button" className="ghost" onClick={skip}>Skip (use defaults)</button>}
            {!last && <button type="submit" className="primary" disabled={busy}>Next</button>}
            {last && <button type="submit" className="primary" disabled={busy || !pv}>{busy ? 'Creating…' : 'Create'}</button>}
          </>
        )
      )}>
        <ol className="wiz-steps" aria-label="Progress">
          {STEPS.map((s, i) => {
            const state = result || i < step ? 'done' : i === step ? 'now' : '';
            return <li key={s} className={`wiz-step ${state}`} aria-current={i === step && !result ? 'step' : undefined}><span className="n">{state === 'done' ? '✓' : i + 1}</span><span className="t">{s}</span></li>;
          })}
        </ol>

        {step === 0 && (
          <>
            <div className="hint">
              {status.demo
                ? 'Demo mode: you can walk through the screens, but nothing is written.'
                : <>Want to look around first? Start the deck in demo mode with <code>DEKKI_DEMO=1 npm start</code>.</>}
            </div>
            <label>
              Working folder
              <span className="wiz-path">
                <input type="text" autoFocus value={form.root} placeholder="/path/to/the/folder/with/your/projects" onChange={(e) => set({ root: e.target.value })} spellCheck={false} />
                {status.canPick && <button type="button" onClick={() => pick('/api/root/pick', 'root')}>Choose folder…</button>}
              </span>
              <span className="hint">New agents start the manager here. It holds one folder per project.</span>
            </label>
            {folderErr('root') && <div className="wiz-bad">{folderErr('root')}</div>}
            {!folderErr('root') && candidate && (candidate.ok ? (
              <div className="wiz-repos" aria-live="polite">
                {candidate.repos.length === 0 ? <span className="hint">No project folders in there yet.</span> : (
                  <>
                    <span className="hint">{candidate.repos.length} folder{candidate.repos.length === 1 ? '' : 's'}{candidate.more ? ` (+${candidate.more} more)` : ''}, {candidate.repos.filter((r) => r.git).length} {candidate.repos.filter((r) => r.git).length === 1 ? 'is a git repo' : 'are git repos'}:</span>
                    <span className="chips">
                      {candidate.repos.slice(0, 8).map((r) => <span key={r.name} className={`chip${r.git ? ' gr' : ''}`} title={r.git ? 'git repo' : 'not a git repo'}>{r.name}</span>)}
                      {candidate.repos.length > 8 && <span className="chip">+{candidate.repos.length - 8}</span>}
                    </span>
                  </>
                )}
              </div>
            ) : <div className="wiz-bad">{candidate.error}</div>)}
            <label>
              Docs folder
              <span className="wiz-path">
                <input type="text" value={form.docsDir} placeholder="/path/to/your/notes (no default)" onChange={(e) => set({ docsDir: e.target.value, createDocsDir: false })} spellCheck={false} />
                {status.canPick && <button type="button" onClick={() => pick('/api/docs/pick', 'docsDir')}>Choose folder…</button>}
              </span>
              <span className="hint">Where the project docs live. Pick a folder outside the working folder.</span>
            </label>
            {folderErr('docsDir') && <div className="wiz-bad">{folderErr('docsDir')}</div>}
            {pv && pv.docs.exists && <div className="wiz-good">✓ Folder found and writable.</div>}
            {pv && pv.docs.needsCreate && (
              <label className="inline">
                <input type="checkbox" checked={form.createDocsDir} onChange={(e) => set({ createDocsDir: e.target.checked })} />
                This folder does not exist yet. Create it.
              </label>
            )}
          </>
        )}

        {step === 1 && (
          <>
            {status.reuse.length > 0 && (
              <label className="inline wiz-reuse">
                <input type="checkbox" checked={reuseId !== ''} onChange={(e) => toggleReuse(e.target.checked ? status.reuse[0].id : '')} />
                Reuse my choices from
                {status.reuse.length > 1 ? (
                  <select value={reuseId || status.reuse[0].id} onChange={(e) => reuseId && toggleReuse(e.target.value)}>
                    {status.reuse.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                ) : <b>{status.reuse[0].label}</b>}
                <span className="hint">(also fills Safety; never the docs folder)</span>
              </label>
            )}
            {prefRow(PREF_ROWS[0], true)}
            {prefRow(PREF_ROWS[1])}
            <fieldset className="wiz-row">
              <legend>Git habits</legend>
              <div className="wiz-sub">Protected branches (never pushed to or merged by an agent)</div>
              <div className="chips wiz-chips">
                {form.protectedBranches.map((b) => (
                  <span key={b} className="chip ac wiz-chip">{b}<button type="button" className="ghost wiz-x" aria-label={`Remove ${b}`} onClick={() => set({ protectedBranches: removeBranch(form.protectedBranches, b) })}>×</button></span>
                ))}
                <input
                  type="text"
                  className="wiz-chip-in"
                  value={branchText}
                  placeholder="add a branch"
                  aria-label="Add a protected branch"
                  onChange={(e) => setBranchText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); } }}
                  onBlur={addFromInput}
                />
              </div>
              <div className="wiz-sub">Pull requests</div>
              {PREF_ROWS[2].options.map((o) => radio('pref-prs', o.value, form.preferences.prs === o.value, () => set({ preferences: { ...form.preferences, prs: o.value } }), o.label, o.hint))}
            </fieldset>
            <fieldset className="wiz-row">
              <legend>Language</legend>
              {radio('pref-language', 'same', form.preferences.language === 'same', () => set({ preferences: { ...form.preferences, language: 'same' } }), 'Same as I write', 'Default')}
              <label className="radio">
                <input type="radio" name="pref-language" value="custom" checked={form.preferences.language === 'custom'} onChange={() => set({ preferences: { ...form.preferences, language: 'custom' } })} />
                <span className="wiz-lang"><b>Another language</b>
                  <input type="text" value={form.languageName} placeholder="for example Dutch" aria-label="Language name" onFocus={() => form.preferences.language !== 'custom' && set({ preferences: { ...form.preferences, language: 'custom' } })} onChange={(e) => set({ languageName: e.target.value, preferences: { ...form.preferences, language: 'custom' } })} />
                </span>
              </label>
            </fieldset>
          </>
        )}

        {step === 2 && (
          <>
            <div className="hint">Both are optional. Skip them if nothing here applies.</div>
            <label>
              What must never be touched?
              <input type="text" autoFocus value={form.neverTouch} placeholder="for example production, billing, live accounts" onChange={(e) => set({ neverTouch: e.target.value })} />
              <span className="hint">Every agent is told this, word for word.</span>
            </label>
            <label>
              Folder that holds your secrets
              <input type="text" value={form.secretsDir} placeholder="/path/to/secrets" onChange={(e) => set({ secretsDir: e.target.value })} spellCheck={false} />
              <span className="hint">Agents may use what is in it (for example, load a file into a command) but never read it.</span>
            </label>
          </>
        )}

        {step === 3 && !result && (
          <>
            {!pv && !err && <div className="hint">Checking…</div>}
            {preview && !preview.ok && <div className="err">{preview.error}</div>}
            {pv && (
              <>
                <div className="wiz-sum">{counts.create} to create{counts.update ? `, ${counts.update} to update` : ''}, {counts.left} already there{counts.flagged ? `, ${counts.flagged} flagged` : ''}. Nothing that exists is overwritten.</div>
                <div className="wiz-list-h">In the working folder</div>
                <ul className="wiz-files">{rootFiles.map(fileRow)}</ul>
                <div className="wiz-list-h">In the docs folder</div>
                <ul className="wiz-files">{docFiles.map(fileRow)}</ul>
                {notice && (
                  <div className="wiz-notice">
                    <div><b>{notice.text}</b></div>
                    <label className="inline">
                      <input type="checkbox" checked={form.appendBlocks} onChange={(e) => set({ appendBlocks: e.target.checked })} />
                      {notice.option}
                    </label>
                    <div className="hint">Or copy the text and paste it yourself:</div>
                    <CopyBox text={pv.claude.blocksText} />
                  </div>
                )}
                {pv.warnings.map((w) => <div key={w} className="wiz-bad">{w}</div>)}
              </>
            )}
          </>
        )}

        {step === 3 && result && (
          <>
            <div className="ok wiz-result">{resultLines(result).join('\n')}</div>
            <TrustBlock trust={result.trust} />
            {health ? <HealthList items={health.items} /> : <div className="hint">Checking…</div>}
            {health && !health.ok && <div className="hint">Fix what is marked, then press Check again.</div>}
          </>
        )}
        {err && <div className="err">{err}</div>}
      </Dialog>
      {confirmClose && (
        <ConfirmDialog
          title="Close setup?"
          text="What you typed is not saved. Nothing has been written yet."
          confirmLabel="Close"
          onClose={() => setConfirmClose(false)}
          onConfirm={() => { setConfirmClose(false); onClose(); }}
        />
      )}
    </>
  );
}
