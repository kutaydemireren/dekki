import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/base.css';
import './styles/sidebar.css';
import './styles/main.css';
import './styles/history.css';
import './styles/changes.css';
import './styles/dialogs.css';
import './styles/panels.css';
import './styles/power.css';
import './styles/motion.css';

// Every pulsing dot blinks in phase: when a pulse starts, pin it to the document timeline origin.
document.addEventListener('animationstart', (e) => {
  if (e.animationName !== 'pulse' || !e.target.getAnimations) return;
  for (const a of e.target.getAnimations()) if (a.animationName === 'pulse') a.startTime = 0;
});

createRoot(document.getElementById('root')).render(<App />);
