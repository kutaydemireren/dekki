import React from 'react';
import Dialog from './Dialog.jsx';
import { MOD } from './shortcuts.js';

// What the keyboard layer (useShortcuts.js) really does. Letter keys are off while an input, a dialog or the terminal has focus.
const ROWS = [
  [[`${MOD}K`, '/'], 'Command palette: jump to an agent or run an action'],
  [['J', 'K'], 'Select the next / previous agent in the list'],
  [['N'], 'Select the next agent that needs you'],
  [['C'], 'New agent'],
  [[`${MOD}1`, `${MOD}9`], 'Select the 1st to 9th pinned agent'],
  [['?'], 'This sheet'],
  [['Esc'], 'Close the top-most dialog or palette'],
];

export default function ShortcutSheet({ onClose }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} className="sheet" actions={<button className="primary" onClick={onClose}>Close</button>}>
      <div className="hint">Letter keys work only when no text field, dialog or the terminal has focus.</div>
      <dl className="keys">
        {ROWS.map(([keys, text]) => (
          <div key={text}><dt>{keys.map((k, i) => <React.Fragment key={k}>{i > 0 && ' '}<kbd>{k}</kbd></React.Fragment>)}</dt><dd>{text}</dd></div>
        ))}
      </dl>
    </Dialog>
  );
}
