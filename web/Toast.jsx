import React from 'react';
import { useCurrentToast, dismissToast } from './useToast.js';
import StatusGlyph from './StatusGlyph.jsx';

const GLYPH = { error: 'failed', ok: 'done' };

// Bottom-right, one at a time, announced politely. The live region stays mounted so screen readers pick the text up.
export default function ToastHost() {
  const t = useCurrentToast();
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {t && (
        <div key={t.id} className={`toast ${t.kind}`} onClick={dismissToast}>
          {GLYPH[t.kind] && <StatusGlyph state={GLYPH[t.kind]} />}
          <span>{t.text}</span>
        </div>
      )}
    </div>
  );
}
