// The supported deployment has one Node process. Share this lock between
// extraction and deletion; course write locks alone do not protect DB paths.
const tails = new Map<string, Promise<void>>();

export async function withMaterialLock<T>(courseId: string, materialId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${courseId.toLowerCase()}:${materialId.toLowerCase()}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}
