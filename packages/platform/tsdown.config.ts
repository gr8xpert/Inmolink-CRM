import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cache/index': 'src/cache/index.ts',
    'clock/index': 'src/clock/index.ts',
    'config/index': 'src/config/index.ts',
    'crypto/index': 'src/crypto/index.ts',
    'crypto/password': 'src/crypto/password.ts',
    'errors/index': 'src/errors/index.ts',
    'flags/index': 'src/flags/index.ts',
    'http/index': 'src/http/index.ts',
    'ids/index': 'src/ids/index.ts',
    'logger/index': 'src/logger/index.ts',
    'outbox/index': 'src/outbox/index.ts',
    'queue/index': 'src/queue/index.ts',
    'rate-limit/index': 'src/rate-limit/index.ts',
    'server/index': 'src/server/index.ts',
  },
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  dts: true,
});
