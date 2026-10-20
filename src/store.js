// -----------------------------------------------------------------------------
// Small persistence under /data (the only writable path of the container):
//   - the queries added with the "Add a query" action, and the series each
//     one has shown (their features stay when a series is missing once);
//   - the scene events already announced (server unreachable, failing
//     queries), so that a restart neither announces one twice nor forgets to
//     say the server is back.
// Losing the file loses the queries (add them again: same names, same
// devices). (Adapted from guim31/gladys-prometheus.)
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { FailureLog } from './logs.js';

const logger = createLogger({ name: 'influxdb-store' });
const FILE_NAME = 'influxdb-state.json';

export class Store {
  constructor(directory = process.env.INFLUXDB_DATA_DIR || '/data') {
    this.directory = directory;
    this.path = join(directory, FILE_NAME);
    this.pending = null;
    this.writing = null;
    // Saved after every read: a /data that cannot be written is reported once.
    this.failures = new FailureLog(logger);
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn(`Cannot read ${this.path}: ${err.message}`);
      }
      return {};
    }
  }

  // Writes are coalesced and atomic (temporary file + rename): a crash never
  // leaves half a JSON file behind.
  save(data) {
    this.latest = data;
    if (!this.pending) {
      // Chained after the write in progress, if any: one writer at a time.
      this.pending = (this.writing ?? Promise.resolve()).then(async () => {
        const snapshot = this.latest;
        this.pending = null;
        try {
          await mkdir(this.directory, { recursive: true });
          const temporary = `${this.path}.tmp`;
          await writeFile(temporary, JSON.stringify(snapshot));
          await rename(temporary, this.path);
          this.failures.recover('write', `${this.path} written again`);
        } catch (err) {
          this.failures.fail('write', `Cannot write ${this.path}: ${err.message}`);
        }
      });
      this.writing = this.pending;
    }
    return this.pending;
  }

  /** Resolves once every write requested so far is on disk. */
  flush() {
    return this.writing ?? Promise.resolve();
  }
}
