export type HealthResponse = {
  service: string
  status: 'ok'
  version: string
}

export type CheckStatus = 'ok' | 'warn' | 'error'

export type EnvironmentCheck = {
  name: string
  status: CheckStatus
  message: string
  details: Record<string, unknown>
}

export type EnvironmentResponse = {
  summary: Record<CheckStatus, number>
  checks: EnvironmentCheck[]
  config: Record<string, unknown>
}

export type SpoolStatus = {
  sqlite_path: string
  memory_queue_size: number
  counts: Record<'pending' | 'synced' | 'failed', number>
}

export type VideoConfig = {
  capture: Record<string, unknown>
  stream: Record<string, unknown>
  supported_stream_modes: string[]
  supported_inputs: string[]
  supported_push_protocols: string[]
}

export type InferenceStatus = {
  status: CheckStatus
  mode: 'local' | 'remote'
  message: string
  details: Record<string, unknown>
}

export type DetectionSnapshot = {
  time: string
  object_class: string
  confidence: number
  bbox_x1?: number | null
  bbox_y1?: number | null
  bbox_x2?: number | null
  bbox_y2?: number | null
  bbox_center_x?: number | null
  bbox_center_y?: number | null
  frame_index?: number | null
  inference_device?: string
}

export type CaptureStatus = {
  status: string
  message: string
  started_at: string | null
  stopped_at: string | null
  last_frame_at: string | null
  frames_read: number
  frames_inferred: number
  detections_queued: number
  last_error: string | null
  settings_locked: Record<string, unknown>
  recent_detections: DetectionSnapshot[]
}

export type AnalysisSummary = {
  status: string
  message: string
  window_minutes: number
  class_filter: string[]
  top_classes: Array<{
    object_class: string
    detection_count: number
    avg_confidence: number
  }>
  buckets: Array<{
    bucket: string
    detection_count: number
    avg_confidence: number
  }>
  result_meta: Array<{
    stat_time: string
    task_id: number
    object_class: string
    avg_confidence: number
    total_count: number
    stat_window_seconds: number
  }>
  recent: DetectionSnapshot[]
  error?: string
}

export type ActionResponse = {
  status: string
  [key: string]: unknown
}

export type ConfigValue = string | number | boolean

export type RemoteAction =
  | 'check'
  | 'sync'
  | 'setup'
  | 'configure_database'
  | 'api_start'
  | 'api_status'
  | 'api_stop'
  | 'api_logs'

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)

  if (!response.ok) {
    let detail: string
    try {
      const body = await response.json()
      detail =
        typeof body.detail === 'string'
          ? body.detail
          : body.detail?.message
            ? body.detail.message
            : JSON.stringify(body.detail ?? body)
    } catch {
      detail = `${url} failed: ${response.status}`
    }
    throw new Error(detail)
  }

  return response.json()
}

export async function fetchHealth(): Promise<HealthResponse> {
  return readJson('/api/health')
}

export async function fetchEnvironment(): Promise<EnvironmentResponse> {
  return readJson('/api/environment')
}

export async function probeEnvironment(values: Record<string, ConfigValue>): Promise<EnvironmentResponse & ActionResponse> {
  return readJson('/api/environment/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
}

export async function fetchSpoolStatus(): Promise<SpoolStatus> {
  return readJson('/api/spool/status')
}

export async function fetchVideoConfig(): Promise<VideoConfig> {
  return readJson('/api/video/config')
}

export async function fetchInferenceStatus(): Promise<InferenceStatus> {
  return readJson('/api/inference/status')
}

export async function fetchCaptureStatus(): Promise<CaptureStatus> {
  return readJson('/api/capture/status')
}

export async function fetchAnalysisSummary(): Promise<AnalysisSummary> {
  return readJson('/api/analysis/summary')
}

export async function reloadConfig(): Promise<ActionResponse> {
  return readJson('/api/config/reload', { method: 'POST' })
}

export async function updateConfig(values: Record<string, ConfigValue>): Promise<ActionResponse> {
  return readJson('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
}

export async function probeVideo(): Promise<ActionResponse> {
  return readJson('/api/video/probe', { method: 'POST' })
}

export async function flushSpool(): Promise<ActionResponse> {
  return readJson('/api/spool/flush', { method: 'POST' })
}

export async function startCapture(): Promise<ActionResponse> {
  return readJson('/api/capture/start', { method: 'POST' })
}

export async function stopCapture(): Promise<ActionResponse> {
  return readJson('/api/capture/stop', { method: 'POST' })
}

export async function runRemoteAction(
  action: RemoteAction,
  payload?: { remote_db_password?: string },
): Promise<ActionResponse> {
  return readJson(`/api/remote/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
}
