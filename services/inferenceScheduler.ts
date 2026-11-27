interface InferenceOptions {
  signal?: AbortSignal;
  priority?: number;
}

interface InferenceJob {
  work: () => Promise<unknown>;
  signal?: AbortSignal;
  priority: number;
  order: number;
  started: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  abort: () => void;
}

const jobs: InferenceJob[] = [];
let running = false;
let sequence = 0;
const abortError = () => new DOMException('Image analysis cancelled', 'AbortError');

const drain = () => {
  if (running || !jobs.length) return;
  jobs.sort((a, b) => b.priority - a.priority || a.order - b.order);
  const job = jobs.shift()!;
  if (job.signal?.aborted) { job.abort(); drain(); return; }
  job.started = true;
  running = true;
  // Keep the slot until the underlying work settles, even if its caller has
  // already cancelled. A late worker response must never overlap another model.
  Promise.resolve().then(() => {
    job.signal?.throwIfAborted();
    return job.work();
  }).then(value => {
    if (!job.signal?.aborted) job.resolve(value);
  }, job.reject).finally(() => {
    job.signal?.removeEventListener('abort', job.abort);
    running = false;
    drain();
  });
};

/** One inference at a time across face recognition and photo scene analysis. */
export function runImageInference<T>(work: () => Promise<T>, options: InferenceOptions = {}): Promise<T> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const job: InferenceJob = {
      work, signal: options.signal, priority: options.priority ?? 0, order: sequence++, started: false,
      resolve: value => resolve(value as T), reject,
      abort: () => {
        if (!job.started) {
          const position = jobs.indexOf(job);
          if (position >= 0) jobs.splice(position, 1);
          job.signal?.removeEventListener('abort', job.abort);
        }
        reject(abortError());
      },
    };
    options.signal?.addEventListener('abort', job.abort, { once: true });
    jobs.push(job);
    drain();
  });
}
