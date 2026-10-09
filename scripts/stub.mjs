// Placeholder for a root script whose feature arrives in a later backlog task.
// Fails loudly so nothing silently pretends to work.
const [command = 'this command', task] = process.argv.slice(2);
const owner = task ? `task ${task}` : 'a later task';
console.error(`pnpm ${command} is not implemented yet — it arrives with ${owner} (docs/build/BACKLOG-R1.md).`);
process.exit(1);
