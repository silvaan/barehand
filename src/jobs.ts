/** Background jobs for work that outlives a tool call (multi-GB downloads). */
import { randomBytes } from "node:crypto";

export type JobState = "running" | "done" | "failed";

export interface Job<T = unknown> {
  id: string;
  kind: string;
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  progress?: { done: number; total?: number; note?: string };
  result?: T;
  error?: string;
}

const jobs = new Map<string, Job>();

export function startJob<T>(kind: string, run: (job: Job<T>) => Promise<T>): Job<T> {
  const job: Job<T> = { id: `${kind}-${randomBytes(3).toString("hex")}`, kind, state: "running", startedAt: Date.now() };
  jobs.set(job.id, job as Job);
  run(job).then(
    (result) => Object.assign(job, { state: "done", result, finishedAt: Date.now() }),
    (e: Error) => Object.assign(job, { state: "failed", error: e.message, finishedAt: Date.now() }),
  );
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}
