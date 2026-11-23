import React, { useState } from 'react';
import Dialog from './Dialog.jsx';

// Asks for each {{placeholder}} of a prompt before Insert/Copy. fields: [{name, def}]; a default prefills its field.
export default function PlaceholderDialog({ title, fields, confirmLabel, onSubmit, onClose }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.def ?? ''])));
  return (
    <Dialog title={title} onClose={onClose} onSubmit={(e) => { e.preventDefault(); onSubmit(values); }} actions={(
      <>
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="primary">{confirmLabel}</button>
      </>
    )}>
        {fields.map((f, i) => (
          <label key={f.name}>
            {f.name}
            <input type="text" autoFocus={i === 0} onFocus={(e) => e.target.select()} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
          </label>
        ))}
    </Dialog>
  );
}
