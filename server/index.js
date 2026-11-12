import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const production = process.env.NODE_ENV === 'production';
let hostPassword = process.env.HOST_PASSWORD;

if (!hostPassword) {
  if (production) {
    console.error('HOST_PASSWORD is not set. Add it to the environment and restart.');
    process.exit(1);
  }
  hostPassword = 'fruit';
  console.warn('HOST_PASSWORD is not set. Using the development password "fruit".');
}

const server = createApp({
  hostPassword,
  publicUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
});

server.httpServer.listen(port, () => {
  console.log(`Fruit Stand is running on port ${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close().finally(() => process.exit(0));
  });
}
