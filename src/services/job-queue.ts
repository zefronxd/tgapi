export class QueueFullError extends Error {
  constructor(queueName: string) {
    super(`${queueName} queue is full`);
    this.name = "QueueFullError";
  }
}

type QueueTask<T> = {
  label: string;
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  queuedAt: number;
};

export type QueueSnapshot = {
  name: string;
  concurrency: number;
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  averageMs: number;
};

export class AsyncJobQueue {
  private readonly name: string;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private active = 0;
  private completed = 0;
  private failed = 0;
  private totalDurationMs = 0;
  private waiting: QueueTask<unknown>[] = [];

  constructor(name: string, concurrency: number, maxQueue: number) {
    this.name = name;
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.maxQueue = Math.max(0, Math.floor(maxQueue));
  }

  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency && this.waiting.length >= this.maxQueue) {
      this.log("rejected", { label, reason: "queue_full" });
      return Promise.reject(new QueueFullError(this.name));
    }

    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        label,
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt: Date.now(),
      });
      this.drain();
    });
  }

  snapshot(): QueueSnapshot {
    return {
      name: this.name,
      concurrency: this.concurrency,
      active: this.active,
      waiting: this.waiting.length,
      completed: this.completed,
      failed: this.failed,
      averageMs: this.completed ? Math.round(this.totalDurationMs / this.completed) : 0,
    };
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const item = this.waiting.shift()!;
      this.active++;
      void this.execute(item);
    }
  }

  private async execute<T>(item: QueueTask<T>): Promise<void> {
    const startedAt = Date.now();
    this.log("started", {
      label: item.label,
      waitMs: startedAt - item.queuedAt,
    });

    try {
      const result = await item.task();
      this.completed++;
      this.totalDurationMs += Date.now() - startedAt;
      item.resolve(result);
    } catch (err) {
      this.failed++;
      this.log("failed", {
        label: item.label,
        error: String(err).slice(0, 180),
      });
      item.reject(err);
    } finally {
      this.active--;
      this.log("finished", { label: item.label });
      this.drain();
    }
  }

  private log(event: string, details: Record<string, unknown>): void {
    console.log(JSON.stringify({
      event: "job_queue",
      queue: this.name,
      state: event,
      active: this.active,
      waiting: this.waiting.length,
      ...details,
    }));
  }
}

function envNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const ffmpegQueue = new AsyncJobQueue(
  "ffmpeg",
  // FFmpeg is memory and disk intensive. A lower default prevents multiple
  // conversions from starving each other and getting killed mid-pipeline.
  Math.min(3, envNumber("FFMPEG_CONCURRENCY", 3)),
  // Keep accepting bursts of requests and let the workers drain them. A
  // rejected queue entry makes the first download fail even though the
  // server could have processed it a little later.
  envNumber("FFMPEG_QUEUE_LIMIT", 250),
);

export const ytDlpQueue = new AsyncJobQueue(
  "yt-dlp",
  envNumber("YTDLP_CONCURRENCY", 4),
  envNumber("YTDLP_QUEUE_LIMIT", 250),
);

export function getJobQueueSnapshots(): QueueSnapshot[] {
  return [ffmpegQueue.snapshot(), ytDlpQueue.snapshot()];
}