const DATABASE_NAME = "noteforge";
const DATABASE_VERSION = 1;

export interface LocalAttempt {
  id: string;
  exerciseType: string;
  target: unknown;
  metrics: Record<string, number | undefined>;
  pitchFrames?: unknown[];
  startedAt: string;
  completedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("attempts")) {
        const attempts = database.createObjectStore("attempts", { keyPath: "id" });
        attempts.createIndex("completedAt", "completedAt");
        attempts.createIndex("exerciseType", "exerciseType");
      }
      if (!database.objectStoreNames.contains("skillStates")) {
        database.createObjectStore("skillStates", { keyPath: "skillId" });
      }
      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function saveAttempt(attempt: LocalAttempt): Promise<void> {
  await transact("attempts", "readwrite", (store) => store.put(attempt));
}

export async function recentAttempts(limit = 12): Promise<LocalAttempt[]> {
  const attempts = await transact<LocalAttempt[]>("attempts", "readonly", (store) => store.getAll());
  return attempts.sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, limit);
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await transact("settings", "readwrite", (store) => store.put({ key, value }));
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const record = await transact<{ key: string; value: T } | undefined>("settings", "readonly", (store) => store.get(key));
  return record?.value;
}
