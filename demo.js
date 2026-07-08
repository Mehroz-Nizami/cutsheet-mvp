// demo.js — one-command local demo: spins up a local Postgres (no separate install
// needed) and boots the real server against it, so `npm run demo` + opening
// http://localhost:3000 gets you the actual app, not a mock.
const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const dataDir = path.join(__dirname, '.pgdata');
const isFirstRun = !fs.existsSync(dataDir) || fs.readdirSync(dataDir).length === 0;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'cutsheet',
  password: 'cutsheet',
  port: 5544,
  persistent: true, // data survives between `npm run demo` runs, like a real deploy
});

async function main() {
  if (isFirstRun) {
    console.log('First run — initializing a local Postgres instance in .pgdata/ ...');
    await pg.initialise();
  }
  await pg.start();
  if (isFirstRun) {
    await pg.createDatabase('cutsheet');
  }

  process.env.DATABASE_URL = `postgresql://cutsheet:cutsheet@localhost:5544/cutsheet`;
  process.env.PORT = process.env.PORT || '3000';

  console.log('\nStarting CutSheet...\n');
  require('./server.js');
}

async function shutdown() {
  console.log('\nShutting down local Postgres...');
  try { await pg.stop(); } catch (e) { /* already stopped */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Failed to start demo:', err);
  process.exit(1);
});
