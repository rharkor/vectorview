/**
 * NIPALS PCA: only the top-k components, with a progress tick per component.
 * A full SVD of an 8k × 1536 sample is one blocking call; this is O(n·d·k).
 */
export class NipalsPca {
  private mean: number[] | null = null;
  /** Each row is one principal axis (k × d). */
  private components: number[][] = [];
  dims = 0;

  get nComponents(): number {
    return this.components.length;
  }

  async fit(
    sample: number[][],
    k: number,
    options: {
      maxIter?: number;
      tol?: number;
      onComponent?: (done: number, total: number) => void;
    } = {},
  ): Promise<void> {
    if (sample.length < 2) throw new Error("PCA needs at least two rows");
    const n = sample.length;
    const d = sample[0].length;
    const nComp = Math.max(1, Math.min(k, n - 1, d));
    const maxIter = options.maxIter ?? 40;
    const tol = options.tol ?? 1e-6;

    this.dims = d;
    this.mean = meanOf(sample, d);
    const work = subtractMean(sample, this.mean);
    this.components = [];

    for (let c = 0; c < nComp; c++) {
      let t = work.map((row) => row[0] ?? 0);
      let p = new Array<number>(d).fill(0);

      for (let iter = 0; iter < maxIter; iter++) {
        let t2 = 0;
        for (const ti of t) t2 += ti * ti;
        if (t2 < 1e-18) break;

        const pNew = new Array<number>(d).fill(0);
        for (let i = 0; i < n; i++) {
          const ti = t[i];
          const row = work[i];
          for (let j = 0; j < d; j++) pNew[j] += row[j] * ti;
        }
        let pNorm = 0;
        for (let j = 0; j < d; j++) {
          pNew[j] /= t2;
          pNorm += pNew[j] * pNew[j];
        }
        pNorm = Math.sqrt(pNorm);
        if (pNorm < 1e-18) break;
        for (let j = 0; j < d; j++) pNew[j] /= pNorm;

        const tNew = new Array<number>(n);
        for (let i = 0; i < n; i++) {
          let sum = 0;
          const row = work[i];
          for (let j = 0; j < d; j++) sum += row[j] * pNew[j];
          tNew[i] = sum;
        }

        let diff = 0;
        for (let j = 0; j < d; j++) {
          const delta = pNew[j] - p[j];
          diff += delta * delta;
        }
        p = pNew;
        t = tNew;
        if (iter > 0 && diff < tol) break;
      }

      this.components.push(p);
      for (let i = 0; i < n; i++) {
        const ti = t[i];
        const row = work[i];
        for (let j = 0; j < d; j++) row[j] -= ti * p[j];
      }
      options.onComponent?.(c + 1, nComp);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  predict(batch: number[][], nComponents?: number): number[][] {
    if (!this.mean || this.components.length === 0) {
      throw new Error("PCA has not been fit");
    }
    const k = Math.min(
      nComponents ?? this.components.length,
      this.components.length,
    );
    const mean = this.mean;
    const axes = this.components;
    return batch.map((row) => {
      const out = new Array<number>(k);
      for (let c = 0; c < k; c++) {
        const axis = axes[c];
        let sum = 0;
        for (let j = 0; j < mean.length; j++) sum += (row[j] - mean[j]) * axis[j];
        out[c] = sum;
      }
      return out;
    });
  }
}

function meanOf(batch: number[][], d: number): number[] {
  const mean = new Array<number>(d).fill(0);
  for (const row of batch) {
    for (let j = 0; j < d; j++) mean[j] += row[j];
  }
  const inv = 1 / batch.length;
  for (let j = 0; j < d; j++) mean[j] *= inv;
  return mean;
}

function subtractMean(batch: number[][], mean: number[]): number[][] {
  return batch.map((row) => row.map((v, j) => v - mean[j]));
}
