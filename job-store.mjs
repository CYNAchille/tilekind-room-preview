import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { recoveryError, errorPayload } from './recovery-errors.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
};
export function requestFingerprint(body) {
  const { clientRequestId, ...submitted } = body;
  return createHash('sha256').update(canonical(submitted)).digest('hex');
}

export async function atomicWrite(file, bytes) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

export class JobStore {
  constructor(directory) { this.directory = directory; this.requests = new Map(); this.unreadable = false; this.pendingWrites = new Map(); }
  async save(record) {
    const snapshot = JSON.stringify(record, null, 2) + '\n';
    const prior = this.pendingWrites.get(record.id) || Promise.resolve();
    const pending = prior.catch(() => {}).then(() => atomicWrite(join(this.directory, record.id + '.json'), snapshot));
    this.pendingWrites.set(record.id, pending);
    try {
      await pending;
      if (record.clientRequestId) this.requests.set(record.clientRequestId, { jobId: record.id, fingerprint: record.requestFingerprint });
    } finally { if (this.pendingWrites.get(record.id) === pending) this.pendingWrites.delete(record.id); }
  }
  async load(id) {
    if (!UUID.test(id)) return null;
    try {
      const record = JSON.parse(await readFile(join(this.directory, id + '.json'), 'utf8'));
      if (record.id !== id || !['queued', 'running', 'done', 'failed', 'cancelled'].includes(record.status)) throw new Error('Invalid job record');
      return record;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      this.unreadable = true;
      throw recoveryError('history_unavailable');
    }
  }
  async initialise() {
    await mkdir(this.directory, { recursive: true });
    const records = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      try {
        const record = await this.load(name.slice(0, -5));
        if (!record) continue;
        if (record.clientRequestId) {
          if (!UUID.test(record.clientRequestId) || !/^[0-9a-f]{64}$/.test(record.requestFingerprint || '')) throw new Error('Invalid request identity');
          const previous = this.requests.get(record.clientRequestId);
          if (previous && previous.jobId !== record.id) throw new Error('Ambiguous request identity');
          this.requests.set(record.clientRequestId, { jobId: record.id, fingerprint: record.requestFingerprint });
        }
        if (['queued', 'running'].includes(record.status)) {
          record.previousStatus = record.status;
          record.status = 'failed'; record.phase = 'interrupted';
          record.finishedAt = new Date().toISOString();
          record.recoveredAt = record.finishedAt;
          Object.assign(record, errorPayload(recoveryError('interrupted')));
          record.executionState = 'uncertain';
          await this.save(record);
        }
        records.push(record);
      } catch { this.unreadable = true; }
    }
    return records;
  }
}
