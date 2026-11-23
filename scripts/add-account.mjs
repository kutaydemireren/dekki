// Add a Claude account to the local deck state: node scripts/add-account.mjs <label> <configDir>
// e.g. node scripts/add-account.mjs Second ~/.claude-second   (state file: ~/.dekki/state.json or DEKKI_STATE)
// Does not log in. Run `CLAUDE_CONFIG_DIR=<configDir> claude auth login` yourself afterwards.
import { addAccount } from '../server/accounts.js';
import { statePath } from '../server/state.js';

const [label, configDir] = process.argv.slice(2);
if (!label || !configDir) {
  console.error('usage: node scripts/add-account.mjs <label> <configDir>');
  process.exit(2);
}
try {
  const a = addAccount(label, configDir);
  console.log(`Added account "${a.label}" (${a.id}) -> ${a.configDir} in ${statePath()}. No restart needed; reload the deck page.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
