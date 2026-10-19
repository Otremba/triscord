// Use the actual application server. Disable external TURN credential requests
// so the native integration test is deterministic and has no cloud side effects.
const fs = require('node:fs');
global.fetch = async () => ({ ok: false });
const { server, io } = require('../../server/server');
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(process.argv[2], String(server.address().port));
});
function stop() {
  io.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
