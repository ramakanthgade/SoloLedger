export type CancelScheduledRead = () => void;
export type ScheduleCoherentRead = (callback: () => void) => CancelScheduledRead;

export interface CoherentSnapshotCompletion<TRevision, TSnapshot> {
  revision: TRevision;
  snapshot: TSnapshot;
}

/** Generation-safe, coalescing scheduler for coherent aggregate reads. */
export class CoherentSnapshotLoader<TRevision, TSnapshot> {
  private disposed = false;
  private inFlight = false;
  private pending?: { revision: TRevision; immediate: boolean };
  private scheduled?: { revision: TRevision };
  private cancelScheduled?: CancelScheduledRead;

  constructor(
    private readonly read: () => Promise<TSnapshot>,
    private readonly schedule: ScheduleCoherentRead,
    private readonly complete: (completion: CoherentSnapshotCompletion<TRevision, TSnapshot>) => void
  ) {}

  invalidate(revision: TRevision, immediate: boolean): void {
    if (this.disposed) return;
    if (this.inFlight) {
      // One latest follow-up is sufficient: its transactional read observes
      // every committed invalidation that preceded its start.
      this.pending = { revision, immediate: this.pending?.immediate === true || immediate };
      return;
    }
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    this.scheduled = undefined;
    if (immediate) this.start(revision);
    else {
      this.scheduled = { revision };
      this.cancelScheduled = this.schedule(() => {
        this.cancelScheduled = undefined;
        const scheduled = this.scheduled;
        this.scheduled = undefined;
        if (scheduled) this.start(scheduled.revision);
      });
    }
  }

  private start(revision: TRevision): void {
    if (this.disposed) return;
    this.inFlight = true;
    void this.read().then((snapshot) => {
      if (this.disposed) return;
      // A newer invalidation means this result is coherent but superseded.
      // Never expose it between the old and latest requested revisions.
      if (!this.pending) this.complete({ revision, snapshot });
    }).catch(() => {
      // Keep the aggregate surface updating; a pending/latest invalidation can retry.
    }).finally(() => {
      if (this.disposed) return;
      this.inFlight = false;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) this.invalidate(pending.revision, pending.immediate);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    this.scheduled = undefined;
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
  }
}
