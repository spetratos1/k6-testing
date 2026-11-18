// lib/knee.js
// Shared knee/saturation analysis, used by both evaluate.js (per-stage, during the
// run) and merge.js (final). Keeping it in one place means the early-stop decision
// and the final report can never disagree.

function num(v, d) { return Number(v != null ? v : d); }

export function p95Run(s) {
  return s && s.durations_seconds && s.durations_seconds.run ? s.durations_seconds.run.p95 : null;
}

// Annotate stages with warmup flag, ceiling regime, and failure rate.
export function scoreStages(stages, { ceiling = 0, warmup = false } = {}) {
  const ordered = stages.slice().sort((a, b) => a.stage_concurrency - b.stage_concurrency);
  return ordered.map((s, i) => {
    const created = (s.runs && s.runs.created) || 0;
    const failed = (s.runs && s.runs.failed) || 0;
    return Object.assign({}, s, {
      is_warmup: warmup && i === 0,
      regime: ceiling && s.stage_concurrency >= ceiling ? 'at_or_above_ceiling' : 'below_ceiling',
      failure_rate_pct: created > 0 ? Number(((failed / created) * 100).toFixed(2)) : 0,
    });
  });
}

// First stage that breaches a saturation signal, measured against the baseline.
// For throughput_plateau the knee is the PREVIOUS stage (the last good one).
export function detectKnee(scored, saturation = {}) {
  const gainFloor = num(saturation.throughput_gain_floor_pct, 10);
  const p95Rise = num(saturation.p95_run_duration_rise_pct, 50);
  const failPct = num(saturation.failure_rate_pct, 2);

  const measured = scored.filter((s) => !s.is_warmup);
  const baseline = measured[0] || null;
  const basep95 = baseline ? p95Run(baseline) : null;

  let knee = null;
  let signal = null;
  for (let i = 0; i < measured.length; i += 1) {
    const s = measured[i];
    const prev = measured[i - 1];
    if (s.failure_rate_pct > failPct) { knee = s.stage_concurrency; signal = 'failures'; break; }
    const sp95 = p95Run(s);
    if (basep95 && sp95 && ((sp95 - basep95) / basep95) * 100 > p95Rise) {
      knee = s.stage_concurrency; signal = 'p95_run_duration_rise'; break;
    }
    if (prev && prev.throughput_completions_per_min && s.throughput_completions_per_min != null) {
      const gain = ((s.throughput_completions_per_min - prev.throughput_completions_per_min)
        / prev.throughput_completions_per_min) * 100;
      if (gain < gainFloor) { knee = prev.stage_concurrency; signal = 'throughput_plateau'; break; }
    }
  }

  const safe = knee
    ? Math.max(1, Math.floor(knee * 0.8))
    : (measured.length ? measured[measured.length - 1].stage_concurrency : null);
  return { knee, signal, safe, measured_count: measured.length };
}
