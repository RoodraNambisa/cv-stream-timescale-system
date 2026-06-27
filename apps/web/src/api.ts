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
  latest_frame_version: number
  latest_frame_width: number
  latest_frame_height: number
  latest_inference_frame_index: number
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

export type LogLevel = 'info' | 'ok' | 'warn' | 'error'

export type UiLogEvent = {
  id: string
  time: string
  source: string
  level: LogLevel
  event: string
  message: string
  details: Record<string, unknown>
}

export type LogsResponse = {
  status: string
  events: UiLogEvent[]
}

export type WriteRunStatus = {
  status: string
  run: {
    run_id: string
    status: string
    message: string
    started_at: string | null
    finished_at: string | null
    last_result?: Record<string, unknown> | null
  }
}

export type WriteRunInputMode = 'live' | 'sample'

export type AnalysisQueryItem = {
  id: number
  title: string
  sql: string
}

export type AnalysisQueryResult = AnalysisQueryItem & {
  status: string
  columns: string[]
  rows: Record<string, unknown>[]
  row_count: number
  truncated?: boolean
  error?: string
}

export type AnalysisQueriesResponse = {
  status: string
  queries: AnalysisQueryItem[]
}

export type AnalysisRunResponse = {
  status: string
  message: string
  queries: AnalysisQueryItem[]
  results: AnalysisQueryResult[]
  error?: string
}

export type MaintenanceClearResponse = {
  status: string
  message: string
  results?: Array<Record<string, unknown>>
}

export type ConfigValue = string | number | boolean
export const API_BASE_STORAGE_KEY = 'cv-stream-timescale-api-base-url'
export const API_TOKEN_STORAGE_KEY = 'cv-stream-timescale-api-token'

export type RemoteAction =
  | 'check'
  | 'sync'
  | 'setup'
  | 'configure_database'
  | 'apply_schema'
  | 'api_start'
  | 'api_status'
  | 'api_stop'
  | 'api_logs'

export function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')

  if (!trimmed) {
    return ''
  }

  const parsed = new URL(trimmed)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('API 地址只支持 http 或 https')
  }

  return parsed.toString().replace(/\/+$/, '')
}

export function getApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(API_BASE_STORAGE_KEY) ?? ''
}

export function getApiAuthToken(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? ''
}

export function setApiBaseUrl(value: string): string {
  const normalized = normalizeApiBaseUrl(value)

  if (typeof window !== 'undefined') {
    if (normalized) {
      window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized)
    } else {
      window.localStorage.removeItem(API_BASE_STORAGE_KEY)
    }
  }

  return normalized
}

export function setApiAuthToken(value: string): string {
  const token = value.trim()

  if (typeof window !== 'undefined') {
    if (token) {
      window.localStorage.setItem(API_TOKEN_STORAGE_KEY, token)
    } else {
      window.localStorage.removeItem(API_TOKEN_STORAGE_KEY)
    }
  }

  return token
}

function resolveApiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url
  }

  const baseUrl = getApiBaseUrl()
  if (!baseUrl) {
    return url
  }

  const path = url.startsWith('/') ? url : `/${url}`
  return `${baseUrl}${path}`
}

function withAuthHeaders(init?: RequestInit): RequestInit | undefined {
  const token = getApiAuthToken()
  if (!token) {
    return init
  }

  const headers = new Headers(init?.headers)
  if (!headers.has('Authorization') && !headers.has('X-API-Key')) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return { ...init, headers }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resolvedUrl = resolveApiUrl(url)
  const response = await fetch(resolvedUrl, withAuthHeaders(init))

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
      detail = `${resolvedUrl} failed: ${response.status}`
    }
    throw new Error(detail)
  }

  return response.json()
}

export async function probeApiBaseUrl(value: string): Promise<HealthResponse> {
  const normalized = normalizeApiBaseUrl(value)
  return readJson(`${normalized}/api/health`)
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

export async function fetchCaptureFrame(): Promise<{ blob: Blob; version: number }> {
  const resolvedUrl = resolveApiUrl(`/api/capture/frame.jpg?t=${Date.now()}`)
  const response = await fetch(
    resolvedUrl,
    withAuthHeaders({
      cache: 'no-store',
    }),
  )

  if (!response.ok) {
    throw new Error(`${resolvedUrl} failed: ${response.status}`)
  }

  return {
    blob: await response.blob(),
    version: Number(response.headers.get('x-frame-version') ?? 0),
  }
}

export async function fetchAnalysisSummary(): Promise<AnalysisSummary> {
  return readJson('/api/analysis/summary')
}

export async function fetchLogEvents(params?: {
  source?: string
  level?: string
  q?: string
  limit?: number
}): Promise<LogsResponse> {
  const search = new URLSearchParams()
  if (params?.source) {
    search.set('source', params.source)
  }
  if (params?.level) {
    search.set('level', params.level)
  }
  if (params?.q) {
    search.set('q', params.q)
  }
  if (params?.limit) {
    search.set('limit', String(params.limit))
  }
  const suffix = search.toString() ? `?${search}` : ''
  return readJson(`/api/logs/events${suffix}`)
}

export async function fetchWriteRunStatus(): Promise<WriteRunStatus> {
  return readJson('/api/logs/write-run/status')
}

export async function startWriteRun(values: {
  input_mode?: WriteRunInputMode
  max_frames: number
  frame_interval?: number
}): Promise<ActionResponse> {
  return readJson('/api/logs/write-run/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
}

export async function stopWriteRun(): Promise<ActionResponse> {
  return readJson('/api/logs/write-run/stop', { method: 'POST' })
}

export async function clearLogEvents(): Promise<ActionResponse> {
  return readJson('/api/logs/events/clear', { method: 'POST' })
}

export async function clearRuntimeData(values: {
  clear_spool: boolean
  clear_timescale: boolean
  confirm?: string
}): Promise<MaintenanceClearResponse> {
  return readJson('/api/logs/maintenance/clear-data', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  })
}

export async function fetchAnalysisQueries(): Promise<AnalysisQueriesResponse> {
  return readJson('/api/logs/analysis/queries')
}

export async function runAnalysisQueries(values?: {
  query_ids?: number[]
  row_limit?: number
}): Promise<AnalysisRunResponse> {
  return readJson('/api/logs/analysis/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values ?? {}),
  })
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
