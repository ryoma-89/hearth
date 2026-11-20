/**
 * Machine resource sampling for the GUI: CPU, RAM, and NVIDIA GPU (via
 * nvidia-smi). GPU numbers are cached briefly so polling clients do not spawn
 * a process per request; when nvidia-smi is unavailable the reason is returned
 * instead of zeros.
 */
import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'

export interface GpuSample {
  name: string
  utilizationPct: number
  memoryUsedMiB: number
  memoryTotalMiB: number
  temperatureC: number
}

export interface ResourceSample {
  ts: string
  cpu: { cores: number; usagePct: number | null }
  memory: { totalBytes: number; usedBytes: number; usagePct: number }
  gpus: GpuSample[]
  gpuUnavailable?: string
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/** Parse `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): GpuSample[] {
  return output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [name, util, used, total, temp] = l.split(',').map(s => s.trim())
      return { name: name ?? 'GPU', utilizationPct: Number(util), memoryUsedMiB: Number(used), memoryTotalMiB: Number(total), temperatureC: Number(temp) }
    })
    .filter(g => Number.isFinite(g.memoryTotalMiB))
}

export class ResourceSampler {
  private last = cpuTimes()
  private gpuCache: { at: number; gpus: GpuSample[]; error?: string } | undefined
  private gpuPending: Promise<void> | undefined
  private readonly gpuTtlMs: number

  constructor(gpuTtlMs = 3000) {
    this.gpuTtlMs = gpuTtlMs
  }

  private refreshGpu(): Promise<void> {
    this.gpuPending ??= new Promise<void>(resolve => {
      execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        this.gpuCache = error ? { at: Date.now(), gpus: [], error: `nvidia-smi unavailable: ${error.message.split('\n')[0]}` } : { at: Date.now(), gpus: parseNvidiaSmi(stdout) }
        this.gpuPending = undefined
        resolve()
      })
    })
    return this.gpuPending
  }

  async sample(): Promise<ResourceSample> {
    const now = cpuTimes()
    const dTotal = now.total - this.last.total
    const usage = dTotal > 0 ? Math.round((1 - (now.idle - this.last.idle) / dTotal) * 1000) / 10 : null
    this.last = now
    if (!this.gpuCache || Date.now() - this.gpuCache.at > this.gpuTtlMs) await this.refreshGpu()
    const total = totalmem()
    const used = total - freemem()
    return {
      ts: new Date().toISOString(),
      cpu: { cores: cpus().length, usagePct: usage },
      memory: { totalBytes: total, usedBytes: used, usagePct: Math.round((used / total) * 1000) / 10 },
      gpus: this.gpuCache?.gpus ?? [],
      ...(this.gpuCache?.error ? { gpuUnavailable: this.gpuCache.error } : {}),
    }
  }
}
