export class FrameStats {
  constructor({ budgetMs, quantumMs }) {
    this.budgetMs = budgetMs;
    this.quantumMs = quantumMs;
    this.durations = [];
  }

  get count() {
    return this.durations.length;
  }

  record(durationMs) {
    this.durations.push(durationMs);
  }

  drain() {
    const sorted = this.durations.slice().sort((a, b) => a - b);
    const count = sorted.length;
    this.durations = [];

    const summary = {
      count,
      meanMs: 0,
      p95Ms: 0,
      maxMs: 0,
      overBudget: 0,
      overQuantum: 0,
      budgetMs: this.budgetMs,
      quantumMs: this.quantumMs,
    };
    if (count === 0) return summary;

    summary.meanMs = sorted.reduce((total, d) => total + d, 0) / count;
    summary.p95Ms = sorted[Math.ceil(count * 0.95) - 1];
    summary.maxMs = sorted[count - 1];
    summary.overBudget = sorted.filter((d) => d > this.budgetMs).length;
    summary.overQuantum = sorted.filter((d) => d > this.quantumMs).length;
    return summary;
  }
}
