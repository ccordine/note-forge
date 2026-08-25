const DATABASE_NAME = "noteforge-local-recording-chunks";
const DATABASE_VERSION = 1;
const CHUNK_STORE_NAME = "chunks";
const RECORDING_INDEX_NAME = "by-recording";

interface StoredRecordingChunk {
  readonly recordingId: string;
  readonly sequence: number;
  readonly data: Blob;
}

/** One durable temporary recording assembled only after the user presses Stop. */
export interface LocalRecordingChunkSession {
  readonly append: (chunk: Blob) => Promise<void>;
  readonly finalize: (mimeType: string) => Promise<Blob>;
  readonly discard: () => Promise<void>;
}

/** Shared authority for live recording chunks; feature code never retains a Blob list. */
export interface LocalRecordingChunkStore {
  readonly create: (recordingId: string) => Promise<LocalRecordingChunkSession>;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("Local recording storage transaction failed."),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("Local recording storage transaction was aborted."),
    );
  });
}

function recordingIndex(transaction: IDBTransaction): IDBIndex {
  return transaction.objectStore(CHUNK_STORE_NAME).index(RECORDING_INDEX_NAME);
}

/**
 * IndexedDB-backed temporary recording storage. Each MediaRecorder timeslice is
 * committed before the next one is accepted, so a live take does not accumulate
 * encoded audio in JavaScript memory.
 */
export class IndexedDbLocalRecordingChunkStore implements LocalRecordingChunkStore {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory?: IDBFactory) {}

  async create(recordingId: string): Promise<LocalRecordingChunkSession> {
    if (!recordingId) throw new TypeError("A local recording id is required.");
    const database = await this.database();
    await this.deleteRecording(database, recordingId);
    return new IndexedDbLocalRecordingChunkSession(database, recordingId);
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) {
      return Promise.reject(new Error(
        "Durable local recording storage is unavailable in this browser.",
      ));
    }
    this.databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (database.objectStoreNames.contains(CHUNK_STORE_NAME)) return;
        const chunks = database.createObjectStore(CHUNK_STORE_NAME, {
          keyPath: ["recordingId", "sequence"],
        });
        chunks.createIndex(RECORDING_INDEX_NAME, "recordingId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(
        request.error ?? new Error("Could not open durable local recording storage."),
      );
      request.onblocked = () => reject(new Error(
        "Durable local recording storage is blocked by another Note Forge tab.",
      ));
    });
    return this.databasePromise;
  }

  private async deleteRecording(database: IDBDatabase, recordingId: string): Promise<void> {
    const transaction = database.transaction(CHUNK_STORE_NAME, "readwrite");
    const cursorRequest = recordingIndex(transaction).openKeyCursor(recordingId);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      transaction.objectStore(CHUNK_STORE_NAME).delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(transaction);
  }
}

class IndexedDbLocalRecordingChunkSession implements LocalRecordingChunkSession {
  private nextSequence = 0;
  private sealed = false;

  constructor(
    private readonly database: IDBDatabase,
    private readonly recordingId: string,
  ) {}

  readonly append = async (chunk: Blob): Promise<void> => {
    if (this.sealed) throw new Error("This local recording is already finalized.");
    if (chunk.size === 0) return;
    const record: StoredRecordingChunk = {
      recordingId: this.recordingId,
      sequence: this.nextSequence,
      data: chunk,
    };
    const transaction = this.database.transaction(CHUNK_STORE_NAME, "readwrite");
    transaction.objectStore(CHUNK_STORE_NAME).add(record);
    await transactionDone(transaction);
    this.nextSequence += 1;
  };

  readonly finalize = async (mimeType: string): Promise<Blob> => {
    if (this.sealed) throw new Error("This local recording is already finalized.");
    this.sealed = true;
    const transaction = this.database.transaction(CHUNK_STORE_NAME, "readonly");
    const request = recordingIndex(transaction).getAll(this.recordingId);
    await transactionDone(transaction);
    const records = (request.result as StoredRecordingChunk[])
      .sort((left, right) => left.sequence - right.sequence);
    const result = new Blob(records.map((record) => record.data), { type: mimeType });
    await this.deleteStoredChunks();
    return result;
  };

  readonly discard = async (): Promise<void> => {
    this.sealed = true;
    await this.deleteStoredChunks();
  };

  private async deleteStoredChunks(): Promise<void> {
    const transaction = this.database.transaction(CHUNK_STORE_NAME, "readwrite");
    const cursorRequest = recordingIndex(transaction).openKeyCursor(this.recordingId);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      transaction.objectStore(CHUNK_STORE_NAME).delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(transaction);
  }
}

export const LOCAL_RECORDING_CHUNK_STORE: LocalRecordingChunkStore =
  new IndexedDbLocalRecordingChunkStore();
