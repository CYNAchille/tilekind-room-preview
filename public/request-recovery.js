// One submitted design, stored locally for at most 24 hours. No chat or diagnostics.
export const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_DB_NAME = 'tilekind-request-recovery';
const STORE = 'submissions', KEY = 'latest';

export function freezeSnapshot(value) {
  const copy = structuredClone(value);
  const freeze = item => {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  };
  return freeze(copy);
}

export function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function safeRecovery(value, fallback = {}) {
  const actions = ['reconnect','retry_generation','retry_result','change_input','wait','unavailable'];
  const states = ['not_started','uncertain','started','output_received'];
  return {
    action: actions.includes(value?.action) ? value.action : fallback.action || 'reconnect',
    executionState: states.includes(value?.executionState) ? value.executionState : fallback.executionState || 'uncertain',
    retryAfterMs: Number.isFinite(value?.retryAfterMs) && value.retryAfterMs >= 0 ? value.retryAfterMs : null
  };
}

export function retryDelay(attempt, retryAfterMs = 0) {
  return Math.max([1000,2500,5000][Math.min(attempt,2)], retryAfterMs || 0);
}

function dataUrlBlob(dataUrl) {
  const separator = dataUrl.indexOf(','), header = dataUrl.slice(0, separator);
  if (separator < 0 || !/^data:image\/(jpeg|png|webp);base64$/i.test(header)) throw new Error('Unsupported stored photo.');
  const binary = atob(dataUrl.slice(separator + 1)), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return {blob:new Blob([bytes], {type:header.slice(5,-7)}), header};
}

async function blobDataUrl(blob, header) {
  const standard = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The saved photo could not be read.')); reader.readAsDataURL(blob);
  });
  // Preserve the exact original data-URL header for request deduplication.
  return `${header},${String(standard).split(',')[1]}`;
}

export class SubmissionStore {
  constructor() { this.queue = Promise.resolve(); }
  run(operation) {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next; return next;
  }
  async open() {
    return new Promise((resolve, reject) => {
      let request, settled = false;
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Browser storage is unavailable.')); } };
      const timer = setTimeout(fail, 3500);
      try { request = indexedDB.open(RECOVERY_DB_NAME, 1); } catch { fail(); return; }
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onblocked = fail; request.onerror = fail;
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer); resolve(request.result);
      };
    });
  }
  async transact(mode, operation) {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        let result, transaction;
        const timer = setTimeout(() => { try { transaction?.abort(); } catch {} reject(new Error('Browser storage did not respond.')); }, 3500);
        try {
          transaction = database.transaction(STORE, mode);
          const request = operation(transaction.objectStore(STORE));
          if (request) request.onsuccess = () => { result = request.result; };
          transaction.oncomplete = () => { clearTimeout(timer); resolve(result); };
          transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(new Error('Browser storage could not save this design.')); };
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    } finally { database.close(); }
  }
  save(record) {
    const copy = structuredClone(record);
    return this.run(async () => {
      if (copy.snapshot.roomDataUrl) {
        const {blob, header} = dataUrlBlob(copy.snapshot.roomDataUrl);
        copy.photo = blob; copy.photoHeader = header; delete copy.snapshot.roomDataUrl;
        delete copy.room.src;
      }
      await this.transact('readwrite', store => store.put(copy, KEY));
    });
  }
  load() {
    return this.run(async () => {
      const record = await this.transact('readonly', store => store.get(KEY));
      if (!record) return null;
      if (record.version !== 1 || !record.expiresAt || record.expiresAt <= Date.now()) {
        await this.transact('readwrite', store => store.delete(KEY)); return null;
      }
      if (!record.snapshot?.surfaces?.length || !record.clientRequestId || !record.room?.id) {
        await this.transact('readwrite', store => store.delete(KEY)); return null;
      }
      if (record.photo) {
        const src = await blobDataUrl(record.photo, record.photoHeader);
        record.snapshot.roomDataUrl = src; record.room.src = src;
        delete record.photo; delete record.photoHeader;
      }
      return record;
    });
  }
  clear() { return this.run(() => this.transact('readwrite', store => store.delete(KEY))); }
}
