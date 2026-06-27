import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowDownUp,
  BarChart3,
  Cpu,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Focus,
  Gauge,
  HardDrive,
  Layers3,
  ListChecks,
  Maximize2,
  Play,
  RadioTower,
  RotateCw,
  Save,
  ScanLine,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Video,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type AnalysisSummary,
  type AnalysisQueryResult,
  type ActionResponse,
  type CaptureStatus,
  type CheckStatus,
  type ConfigValue,
  type DetectionSnapshot,
  type EnvironmentCheck,
  type EnvironmentResponse,
  type InferenceStatus,
  type LogLevel,
  type WriteRunInputMode,
  type RemoteAction,
  type SpoolStatus,
  type UiLogEvent,
  type VideoConfig,
  fetchAnalysisQueries,
  fetchCaptureStatus,
  fetchCaptureFrame,
  fetchAnalysisSummary,
  fetchEnvironment,
  fetchHealth,
  fetchInferenceStatus,
  fetchLogEvents,
  fetchSpoolStatus,
  fetchVideoConfig,
  fetchWriteRunStatus,
  flushSpool,
  getApiAuthToken,
  getApiBaseUrl,
  clearLogEvents,
  clearRuntimeData,
  probeEnvironment,
  probeVideo,
  reloadConfig,
  runRemoteAction,
  runAnalysisQueries,
  setApiAuthToken,
  startCapture,
  startWriteRun,
  stopWriteRun,
  stopCapture,
  updateConfig,
} from './api'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

type TabKey = 'overview' | 'config' | 'tasks' | 'analysis' | 'logs'

const tabs: Array<{ key: TabKey; label: string; icon: typeof Activity }> = [
  { key: 'overview', label: '总览', icon: Activity },
  { key: 'config', label: '配置', icon: Settings },
  { key: 'tasks', label: '任务', icon: ListChecks },
  { key: 'analysis', label: '分析', icon: BarChart3 },
  { key: 'logs', label: '日志', icon: Terminal },
]

const analysisQueries = [
  '每个设备执行过的 CV 任务数量',
  '某设备指定时间范围内的平均检测置信度',
  '每 10 秒统计设备和类别检测数量',
  '每 1 分钟计算平均置信度',
  '最近 5 分钟出现频次最高的类别',
  '某设备 30 秒内低于 0.6 的检测记录',
  'JOIN device 输出设备名称和热度图数据',
]

const statusColors: Record<CheckStatus, string> = {
  ok: '#0f9f77',
  warn: '#d58913',
  error: '#cf3f46',
}

const logSourceOptions = [
  { value: 'all', label: '全部来源' },
  { value: 'write', label: '写入流程' },
  { value: 'capture', label: '采集' },
  { value: 'spool', label: '缓存写库' },
  { value: 'analysis', label: '时序分析' },
  { value: 'system', label: '系统' },
]

const logLevelOptions: Array<{ value: 'all' | LogLevel; label: string }> = [
  { value: 'all', label: '全部级别' },
  { value: 'info', label: '信息' },
  { value: 'ok', label: '正常' },
  { value: 'warn', label: '警告' },
  { value: 'error', label: '错误' },
]

type LogPaneKey = 'runtime' | 'write' | 'analysis' | 'maintenance'

const logPanes: Array<{ key: LogPaneKey; label: string; icon: typeof Activity }> = [
  { key: 'runtime', label: '运行日志', icon: Terminal },
  { key: 'write', label: '写入流程', icon: Play },
  { key: 'analysis', label: '时序查询', icon: Database },
  { key: 'maintenance', label: '数据维护', icon: Trash2 },
]

type ConfigField = {
  key: string
  label: string
  input: 'text' | 'number' | 'password' | 'select' | 'url'
  options?: string[]
  optionLabels?: Record<string, string>
  placeholder?: string
  helper?: string
  sensitive?: boolean
  span?: 'full'
}

type ConfigGroup = {
  eyebrow: string
  title: string
  icon: typeof Activity
  accent: string
  fields: ConfigField[]
}

type ConfigDraft = Record<string, string>
type ConfigInputMode = 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url'
type ConfigSectionKey = 'access' | 'video' | 'inference' | 'storage' | 'observability' | 'remote'
type FrameDisplayMode = 'contain' | 'cover' | 'adaptive'

const FRAME_DISPLAY_MODE_STORAGE_KEY = 'cv-stream-timescale-frame-display-mode-v2'

const lockedConfigKeys = new Set([
  'CAPTURE_SOURCE_KIND',
  'CAPTURE_SOURCE_URL',
  'STREAM_MODE',
  'STREAM_PROTOCOL',
  'STREAM_PUSH_URL',
  'STREAM_RECEIVER_KIND',
  'INFERENCE_ENDPOINT',
  'INFERENCE_MODEL',
  'DATABASE_URL',
  'SPOOL_SQLITE_PATH',
])

const accessConfigGroup: ConfigGroup = {
  eyebrow: 'Access',
  title: '连接与鉴权',
  icon: ShieldCheck,
  accent: 'accent-security',
  fields: [
    {
      key: 'API_AUTH_TOKEN',
      label: '服务端 API_AUTH_TOKEN',
      input: 'password',
      sensitive: true,
      placeholder: '留空关闭接口鉴权…',
      helper: '保存到服务端配置；启用后，除健康检查外的接口都需要 Bearer token。',
    },
  ],
}

const streamModeField: ConfigField = {
  key: 'STREAM_MODE',
  label: '接入方式',
  input: 'select',
  options: ['pull', 'push'],
  optionLabels: {
    pull: '拉流：系统主动读取视频 URL',
    push: '接收推流：设备推到接收器',
  },
  helper: '两种方式互斥；切换后只显示对应配置。',
}

const pullVideoFields: ConfigField[] = [
  {
    key: 'CAPTURE_SOURCE_KIND',
    label: '输入类型',
    input: 'select',
    options: ['http_mjpeg', 'rtsp', 'rtmp', 'camera', 'file'],
    optionLabels: {
      http_mjpeg: 'HTTP MJPEG',
      rtsp: 'RTSP',
      rtmp: 'RTMP',
      camera: '本机摄像头',
      file: '视频文件',
    },
  },
  {
    key: 'CAPTURE_SOURCE_URL',
    label: '视频地址',
    input: 'url',
    placeholder: 'http://手机IP:8080/video 或 rtsp://host/live…',
    helper: '支持 Android IP Webcam、RTSP、RTMP、文件和本机摄像头。',
    span: 'full',
  },
]

const pushVideoFields: ConfigField[] = [
  {
    key: 'STREAM_PROTOCOL',
    label: '推流协议',
    input: 'select',
    options: ['rtsp', 'rtmp'],
    optionLabels: {
      rtsp: 'RTSP',
      rtmp: 'RTMP',
    },
  },
  {
    key: 'STREAM_RECEIVER_KIND',
    label: '接收器类型',
    input: 'select',
    options: ['none', 'mediamtx', 'nginx_rtmp', 'custom'],
    optionLabels: {
      none: '不托管接收器',
      mediamtx: 'MediaMTX',
      nginx_rtmp: 'nginx-rtmp',
      custom: '自定义',
    },
  },
  {
    key: 'STREAM_PUSH_URL',
    label: '设备推送地址',
    input: 'url',
    placeholder: 'rtmp://server/live/camera-1…',
    helper: '给手机、摄像头或推流客户端使用的目标地址。',
    span: 'full',
  },
  {
    key: 'CAPTURE_SOURCE_URL',
    label: '后端读取地址',
    input: 'url',
    placeholder: 'rtsp://server/live/camera-1 或 rtmp://server/live/camera-1…',
    helper: '设备推到接收器后，后端从这个播放地址读取帧。',
    span: 'full',
  },
  {
    key: 'STREAM_RECEIVER_STATUS_URL',
    label: '接收器状态 URL',
    input: 'url',
    placeholder: 'http://server:9997/v3/config/global/get…',
    helper: 'MediaMTX API、nginx-rtmp stat 或自定义状态接口。',
    span: 'full',
  },
]

const captureMetaFields: ConfigField[] = [
  { key: 'CAPTURE_FPS_LIMIT', label: '采集 FPS 上限', input: 'number' },
  {
    key: 'CAPTURE_ROTATE_DEGREES',
    label: '画面旋转',
    input: 'select',
    options: ['0', '90', '180', '270'],
    optionLabels: {
      '0': '不旋转',
      '90': '顺时针 90°',
      '180': '旋转 180°',
      '270': '逆时针 90°',
    },
    helper: '手机竖屏导致画面侧转时使用；会先转正再预览和推理。',
  },
  { key: 'CAPTURE_DEVICE_ID', label: '设备 ID', input: 'number' },
  { key: 'CAPTURE_TASK_ID', label: '任务 ID', input: 'number' },
]

const pullCredentialFields: ConfigField[] = [
  { key: 'CAPTURE_USERNAME', label: '账号', input: 'text' },
  { key: 'CAPTURE_PASSWORD', label: '密码', input: 'password', sensitive: true },
]

const pushCredentialFields: ConfigField[] = [
  { key: 'STREAM_USERNAME', label: '账号', input: 'text' },
  { key: 'STREAM_PASSWORD', label: '密码', input: 'password', sensitive: true },
]

const videoAccessConfigGroup: ConfigGroup = {
  eyebrow: 'Video Access',
  title: '视频接入',
  icon: Video,
  accent: 'accent-video',
  fields: [
    streamModeField,
    ...pullVideoFields,
    ...pushVideoFields,
    ...pullCredentialFields,
    ...pushCredentialFields,
    ...captureMetaFields,
  ],
}

const workflowConfigGroups: ConfigGroup[] = [
  {
    eyebrow: 'Inference',
    title: '推理配置',
    icon: Cpu,
    accent: 'accent-gpu',
    fields: [
      {
        key: 'INFERENCE_ENDPOINT',
        label: '推理 API URL（可选）',
        input: 'url',
        placeholder: 'http://API_HOST:8000…',
        helper: '留空时使用当前服务本机推理；填写后把帧发送到另一套推理 API。',
        span: 'full',
      },
      {
        key: 'INFERENCE_API_TOKEN',
        label: '推理 API token（可选）',
        input: 'password',
        sensitive: true,
        placeholder: '远端推理 API 启用鉴权时填写…',
        helper: '只随推理请求发给 INFERENCE_ENDPOINT，不是当前前端登录 token。',
      },
      { key: 'INFERENCE_DEVICE', label: '推理设备', input: 'select', options: ['auto', 'cpu', 'cuda'] },
      { key: 'INFERENCE_MODEL', label: '模型文件', input: 'text' },
      { key: 'CONFIDENCE_THRESHOLD', label: '置信度阈值', input: 'number' },
      { key: 'FRAME_INTERVAL', label: '推理帧间隔', input: 'number' },
      { key: 'DETECTION_CLASS_FILTER', label: '类别过滤', input: 'text', placeholder: 'person, car, bicycle…' },
    ],
  },
  {
    eyebrow: 'Analysis',
    title: '分析视图',
    icon: BarChart3,
    accent: 'accent-analysis',
    fields: [
      { key: 'ANALYSIS_TIME_RANGE_MINUTES', label: '图表时间范围分钟', input: 'number' },
    ],
  },
  {
    eyebrow: 'Storage',
    title: '数据库与缓存',
    icon: Database,
    accent: 'accent-db',
    fields: [
      {
        key: 'DATABASE_URL',
        label: '数据库连接串',
        input: 'password',
        sensitive: true,
        placeholder: 'postgresql://user:password@host:5432/cv_stream…',
        helper: '后端直连 PostgreSQL 或 TimescaleDB，不通过 SSH。',
        span: 'full',
      },
      { key: 'DATABASE_CONNECT_TIMEOUT', label: '连接超时秒数', input: 'number' },
      { key: 'DATABASE_BATCH_SIZE', label: '批量写入条数', input: 'number' },
      { key: 'DATABASE_FLUSH_INTERVAL_MS', label: '刷库间隔毫秒', input: 'number' },
      {
        key: 'SPOOL_SQLITE_PATH',
        label: '本地落盘队列路径',
        input: 'text',
        helper: '数据库不可用时先落盘缓存，恢复后再批量写入；内存队列仍用于运行时缓冲。',
      },
    ],
  },
  {
    eyebrow: 'Remote',
    title: '远端管理',
    icon: Server,
    accent: 'accent-remote',
    fields: [
      {
        key: 'REMOTE_API_BASE_URL',
        label: '被管理 API Base URL（可选）',
        input: 'url',
        placeholder: 'http://API_HOST:8000…',
        helper: '只有这台程序需要管理另一套 API 时填写；本机部署保持空。',
        span: 'full',
      },
      { key: 'REMOTE_API_HOST', label: '被管理 API 监听主机（可选）', input: 'text' },
      { key: 'REMOTE_API_PORT', label: '被管理 API 监听端口（可选）', input: 'number' },
      { key: 'REMOTE_SSH_HOST', label: 'SSH 管理主机', input: 'text', placeholder: '可选…' },
      { key: 'REMOTE_SSH_PORT', label: 'SSH 管理端口', input: 'number' },
      { key: 'REMOTE_SSH_USER', label: 'SSH 管理用户', input: 'text', placeholder: '可选…' },
      { key: 'REMOTE_SSH_KEY_PATH', label: 'SSH 私钥路径', input: 'text', placeholder: '可选…' },
      { key: 'REMOTE_PIP_INDEX_URLS', label: 'pip 镜像源列表', input: 'text', placeholder: '空格分隔多个 simple URL…' },
      { key: 'REMOTE_PIP_TRUSTED_HOSTS', label: 'pip trusted-host', input: 'text', placeholder: '空格分隔多个 host…' },
      { key: 'REMOTE_PIP_PROXY', label: 'pip 代理 URL', input: 'password', sensitive: true, placeholder: 'http://user:password@proxy:port…' },
    ],
  },
  {
    eyebrow: 'Observability',
    title: '可观测性',
    icon: Gauge,
    accent: 'accent-observe',
    fields: [
      { key: 'GRAFANA_BASE_URL', label: 'Grafana Base URL', input: 'url', placeholder: 'http://server:3000…' },
      { key: 'GRAFANA_DASHBOARD_URL', label: 'Grafana 面板 URL', input: 'url', placeholder: 'http://server:3000/d/stream…' },
    ],
  },
]

const configGroups = [accessConfigGroup, videoAccessConfigGroup, ...workflowConfigGroups]

const configSectionTabs: Array<{
  key: ConfigSectionKey
  label: string
  eyebrow: string
  icon: typeof Activity
}> = [
  { key: 'access', label: '鉴权', eyebrow: 'Access', icon: ShieldCheck },
  { key: 'video', label: '视频', eyebrow: 'Video', icon: Video },
  { key: 'inference', label: '推理', eyebrow: 'Infer', icon: Cpu },
  { key: 'storage', label: '存储', eyebrow: 'Store', icon: HardDrive },
  { key: 'observability', label: '观测', eyebrow: 'Watch', icon: Gauge },
  { key: 'remote', label: '远端', eyebrow: 'Remote', icon: Server },
]

const tabKeys = new Set<TabKey>(tabs.map((tab) => tab.key))
const confidenceFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const captureStatusRefetchMs = 300
const numberFormatter = new Intl.NumberFormat('zh-CN')
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const remoteActions: Array<{ action: RemoteAction; label: string; icon: typeof Activity }> = [
  { action: 'check', label: 'SSH 检测', icon: ShieldCheck },
  { action: 'sync', label: 'SSH 同步', icon: ArrowDownUp },
  { action: 'setup', label: 'SSH 安装', icon: Wrench },
  { action: 'configure_database', label: 'SSH 配库', icon: Database },
  { action: 'apply_schema', label: '应用数据库结构', icon: Database },
  { action: 'api_start', label: 'SSH 启动 API', icon: Play },
  { action: 'api_status', label: 'SSH API 状态', icon: Activity },
  { action: 'api_stop', label: 'SSH 停止 API', icon: Square },
  { action: 'api_logs', label: 'SSH API 日志', icon: Terminal },
]

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>(() => getTabFromLocation())
  const [frontendApiBase] = useState(() => getApiBaseUrl())
  const [frontendApiToken, setFrontendApiToken] = useState(() => getApiAuthToken())
  const [quickTokenDraft, setQuickTokenDraft] = useState(frontendApiToken)
  const [quickTokenVisible, setQuickTokenVisible] = useState(false)
  const queryClient = useQueryClient()

  useEffect(() => {
    writeTabToUrl(getTabFromLocation(), 'replace')

    function handlePopState() {
      setActiveTab(getTabFromLocation())
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  const health = useQuery({
    queryKey: ['health', frontendApiBase],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  })

  const environment = useQuery({
    queryKey: ['environment', frontendApiBase, frontendApiToken],
    queryFn: fetchEnvironment,
    refetchInterval: 10_000,
  })

  const spool = useQuery({
    queryKey: ['spool', frontendApiBase, frontendApiToken],
    queryFn: fetchSpoolStatus,
    refetchInterval: 10_000,
  })

  const video = useQuery({
    queryKey: ['video-config', frontendApiBase, frontendApiToken],
    queryFn: fetchVideoConfig,
    refetchInterval: 20_000,
  })

  const inference = useQuery({
    queryKey: ['inference-status', frontendApiBase, frontendApiToken],
    queryFn: fetchInferenceStatus,
    refetchInterval: 10_000,
  })

  const capture = useQuery({
    queryKey: ['capture-status', frontendApiBase, frontendApiToken],
    queryFn: fetchCaptureStatus,
    refetchInterval: captureStatusRefetchMs,
  })

  const analysis = useQuery({
    queryKey: ['analysis-summary', frontendApiBase, frontendApiToken],
    queryFn: fetchAnalysisSummary,
    refetchInterval: 10_000,
  })

  const reloadMutation = useMutation({
    mutationFn: reloadConfig,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const updateConfigMutation = useMutation({
    mutationFn: updateConfig,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const configProbeMutation = useMutation({
    mutationFn: probeEnvironment,
  })

  const remoteMutation = useMutation({
    mutationFn: ({ action, payload }: { action: RemoteAction; payload?: { remote_db_password?: string } }) =>
      runRemoteAction(action, payload),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const probeMutation = useMutation({
    mutationFn: probeVideo,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const flushMutation = useMutation({
    mutationFn: flushSpool,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const startMutation = useMutation({
    mutationFn: startCapture,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const stopMutation = useMutation({
    mutationFn: stopCapture,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const apiTokenRequired = [
    environment.error,
    spool.error,
    video.error,
    inference.error,
    capture.error,
    analysis.error,
    reloadMutation.error,
    updateConfigMutation.error,
    configProbeMutation.error,
    remoteMutation.error,
    probeMutation.error,
    flushMutation.error,
    startMutation.error,
    stopMutation.error,
  ].some(isApiTokenRequiredError)
  const apiStatus = health.data?.status ?? (health.isError ? 'offline' : 'checking')
  const environmentChecks = useMemo(
    () => new Map(environment.data?.checks.map((item) => [item.name, item]) ?? []),
    [environment.data?.checks],
  )
  const environmentSummary = environment.data?.summary
  const environmentText = environmentSummary
    ? `${numberFormatter.format(environmentSummary.ok)} 正常 / ${numberFormatter.format(environmentSummary.warn)} 提醒 / ${numberFormatter.format(environmentSummary.error)} 错误`
    : '检测中…'
  const summaryChart = environmentSummary
    ? (Object.entries(environmentSummary) as Array<[CheckStatus, number]>).map(
        ([name, value]) => ({ name, value }),
      )
    : []
  const spoolChart = spool.data
    ? Object.entries(spool.data.counts).map(([name, value]) => ({ name, value }))
    : []
  const topClassChart = analysis.data?.top_classes.map((item) => ({
    name: item.object_class,
    value: item.detection_count,
  })) ?? []
  const bucketChart = analysis.data?.buckets.map((item) => ({
    name: formatBucketLabel(item.bucket),
    value: item.detection_count,
  })) ?? []

  function checkFor(name: string): EnvironmentCheck | undefined {
    return environmentChecks.get(name)
  }

  const grafanaCheck = checkFor('grafana')
  const grafanaHref = grafanaEntryHref(grafanaCheck, environment.data?.config)

  function handleTabChange(tab: TabKey) {
    setActiveTab(tab)
    writeTabToUrl(tab, 'push')
  }

  function handleFrontendApiTokenChange(value: string): string {
    const token = setApiAuthToken(value)
    setFrontendApiToken(token)
    void queryClient.invalidateQueries()
    return token
  }

  function saveQuickApiToken() {
    const token = handleFrontendApiTokenChange(quickTokenDraft)
    setQuickTokenDraft(token)
  }

  function clearQuickApiToken() {
    setQuickTokenDraft('')
    handleFrontendApiTokenChange('')
  }

  return (
    <>
      <a className="skip-link" href="#main-content">跳到主内容</a>
      <main className="shell" id="main-content">
      <header className="command-bar">
        <div className="brand-lockup">
          <span className="brand-mark">
            <ScanLine size={18} aria-hidden="true" />
          </span>
          <div>
            <p className="eyebrow">CV Stream Timescale</p>
            <h1>视频流目标检测链路</h1>
          </div>
        </div>
        <div className="top-actions" aria-label="系统状态">
          <span
            className={`pill ${apiStatus === 'ok' ? 'ok' : 'warn'}`}
            title={frontendApiBase || '同源 /api'}
          >
            <Server size={16} aria-hidden="true" />
            API {apiStatus} · {frontendApiBase ? '远端' : '本地'}
          </span>
          <span className={`pill ${environmentSummary?.error ? 'error' : 'ok'}`}>
            <ShieldCheck size={16} aria-hidden="true" />
            {environmentText}
          </span>
          {grafanaHref && (
            <a
              className="top-action-link grafana-entry-link"
              href={grafanaHref}
              rel="noreferrer"
              target="_blank"
              title="打开 Grafana 监控面板"
            >
              <Gauge size={17} aria-hidden="true" />
              <span>Grafana</span>
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            title="刷新配置"
            onClick={() => reloadMutation.mutate()}
            disabled={reloadMutation.isPending}
          >
            <RotateCw size={18} aria-hidden="true" />
            <span>刷新</span>
          </button>
        </div>
      </header>

      {apiTokenRequired && (
        <section className="auth-prompt panel" aria-live="polite">
          <div className="auth-prompt-copy">
            <span className="auth-prompt-icon">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <p className="eyebrow">Browser Token</p>
              <h2>需要在当前浏览器保存访问令牌</h2>
            </div>
          </div>
          <div className="auth-prompt-controls">
            <div className="secret-input">
              <input
                aria-label="当前浏览器 API token"
                autoComplete="off"
                inputMode="text"
                spellCheck={false}
                type={quickTokenVisible ? 'text' : 'password'}
                value={quickTokenDraft}
                placeholder="输入服务端 API_AUTH_TOKEN…"
                onChange={(event) => setQuickTokenDraft(event.target.value)}
              />
              <button
                type="button"
                aria-label={quickTokenVisible ? '隐藏当前浏览器 API token' : '显示当前浏览器 API token'}
                className="icon-button"
                title={quickTokenVisible ? '隐藏' : '显示'}
                onClick={() => setQuickTokenVisible((current) => !current)}
              >
                {quickTokenVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
              </button>
            </div>
            <button type="button" onClick={saveQuickApiToken} disabled={!quickTokenDraft.trim()}>
              <ShieldCheck size={17} aria-hidden="true" />
              保存浏览器令牌
            </button>
            <button type="button" onClick={clearQuickApiToken} disabled={!frontendApiToken && !quickTokenDraft}>
              <RotateCw size={17} aria-hidden="true" />
              清除
            </button>
          </div>
        </section>
      )}

      <section className="hero-grid">
        <FrameConsole
          captureStatus={capture.data}
          config={environment.data?.config}
          videoConfig={video.data}
        />
        <PipelineMap
          videoCheck={checkFor('video_source')}
          inferenceCheck={checkFor('inference')}
          databaseCheck={checkFor('database')}
          spoolCheck={checkFor('spool')}
        />
      </section>

      <nav className="tabs" aria-label="监控台页面">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              aria-current={activeTab === tab.key ? 'page' : undefined}
              className={activeTab === tab.key ? 'active' : ''}
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
            >
              <Icon size={17} aria-hidden="true" />
              {tab.label}
            </button>
          )
        })}
      </nav>

      <section className="signal-grid" aria-label="运行能力">
        <SignalCard icon={Video} label="视频源" check={checkFor('video_source')} fallback="待配置" />
        <SignalCard icon={Cpu} label="推理端" check={checkFor('inference')} fallback="本地默认" />
        <SignalCard icon={Database} label="数据库" check={checkFor('database')} fallback="待检测" />
        <SignalCard icon={Database} label="数据库结构" check={checkFor('database_schema')} fallback="待检测" />
        <SignalCard icon={HardDrive} label="缓存队列" check={checkFor('spool')} fallback="待检测" />
        <SignalCard icon={RadioTower} label="流媒体接收器" check={checkFor('stream_receiver')} fallback="可选未配置" />
        <SignalCard icon={RadioTower} label="远端 API" check={checkFor('remote_api')} fallback="可选未配置" />
        <SignalCard icon={Gauge} label="Grafana" check={checkFor('grafana')} fallback="可选未配置" />
      </section>

      {activeTab === 'overview' && (
        <OverviewPage
          checks={environment.data?.checks ?? []}
          summaryChart={summaryChart}
          spoolChart={spoolChart}
          analysisSummary={analysis.data}
          captureStatus={capture.data}
        />
      )}

      {activeTab === 'config' && (
        <ConfigPage
          config={environment.data?.config}
          videoConfig={video.data}
          inferenceStatus={inference.data}
          onProbe={() => probeMutation.mutate()}
          probePending={probeMutation.isPending}
          probeResult={probeMutation.data}
          onProbeConfig={(values) => configProbeMutation.mutate(values)}
          configProbePending={configProbeMutation.isPending}
          configProbeResult={configProbeMutation.data}
          configProbeError={configProbeMutation.error?.message}
          onSave={(values) => updateConfigMutation.mutateAsync(values)}
          savePending={updateConfigMutation.isPending}
          saveResult={updateConfigMutation.data}
          saveError={updateConfigMutation.error?.message}
          onRemoteAction={(action, payload) => remoteMutation.mutate({ action, payload })}
          remotePending={remoteMutation.isPending}
          remoteResult={remoteMutation.data}
          remoteError={remoteMutation.error?.message}
        />
      )}

      {activeTab === 'tasks' && (
        <TasksPage
          captureStatus={capture.data}
          spoolStatus={spool.data}
          onStart={() => startMutation.mutate()}
          onStop={() => stopMutation.mutate()}
          startPending={startMutation.isPending}
          stopPending={stopMutation.isPending}
          startResult={startMutation.data}
          stopResult={stopMutation.data}
          onFlush={() => flushMutation.mutate()}
          flushPending={flushMutation.isPending}
          flushResult={flushMutation.data}
        />
      )}

      {activeTab === 'analysis' && (
        <AnalysisPage
          config={environment.data?.config}
          analysisSummary={analysis.data}
          topClassChart={topClassChart}
          bucketChart={bucketChart}
        />
      )}

      {activeTab === 'logs' && (
        <LogsPage
          apiKeySalt={`${frontendApiBase}:${frontendApiToken ? 'token' : 'open'}`}
          captureStatus={capture.data}
        />
      )}
      </main>
    </>
  )
}

function FrameConsole({
  captureStatus,
  config,
  videoConfig,
}: {
  captureStatus?: CaptureStatus
  config?: Record<string, unknown>
  videoConfig?: VideoConfig
}) {
  const captureConfig = videoConfig?.capture ?? pickObject(config, 'capture')
  const source = String(captureConfig.source_url || captureStatus?.settings_locked?.source || '未配置视频源')
  const model = String(pickObject(config, 'inference').model || 'yolov8n.pt')
  const tone = toneFromRuntime(captureStatus?.status)
  const recentDetections = captureStatus?.recent_detections ?? []
  const latestFrameVersion = captureStatus?.latest_frame_version ?? 0
  const latestInferenceFrameIndex = captureStatus?.latest_inference_frame_index ?? 0
  const frameWidth = captureStatus?.latest_frame_width ?? 0
  const frameHeight = captureStatus?.latest_frame_height ?? 0
  const [framePreviewUrl, setFramePreviewUrl] = useState('')
  const [framePreviewError, setFramePreviewError] = useState('')
  const [previewFrameVersion, setPreviewFrameVersion] = useState(0)
  const [frameHudVisible, setFrameHudVisible] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [frameDisplayMode, setFrameDisplayMode] = useState<FrameDisplayMode>(() => getFrameDisplayMode())
  const framePreviewUrlRef = useRef<string | null>(null)
  const framePreviewVersionRef = useRef(0)
  const previewActive = captureStatus?.status === 'running' || latestFrameVersion > 0
  const visibleFramePreviewUrl = previewActive ? framePreviewUrl : ''
  const displayFrameNumber = previewFrameVersion || captureStatus?.frames_read || 0
  const inferenceConfig = pickObject(config, 'inference')
  const configuredFrameInterval = Number(inferenceConfig.frame_interval ?? 10)
  const maxOverlayLagFrames = Math.max(
    8,
    Math.min(30, (Number.isFinite(configuredFrameInterval) ? configuredFrameInterval : 10) * 2),
  )
  const overlayLagFrames = latestInferenceFrameIndex
    ? Math.max(displayFrameNumber - latestInferenceFrameIndex, 0)
    : 0
  const overlayFresh = latestInferenceFrameIndex > 0 && overlayLagFrames <= maxOverlayLagFrames
  const overlayDetections = overlayFresh
    ? recentDetections.filter((detection) => detection.frame_index === latestInferenceFrameIndex)
    : []
  const overlayStatus = latestInferenceFrameIndex
    ? overlayFresh
      ? `检测延迟 ${overlayLagFrames} 帧`
      : `检测滞后 ${overlayLagFrames} 帧，已隐藏旧框`
    : '等待检测框…'
  const queuedText = `${numberFormatter.format(captureStatus?.detections_queued ?? 0)} queued`
  const frameModeAction = `画面比例：${frameDisplayModeLabel(frameDisplayMode)}，点击切换`
  const previewStageStyle = adaptiveFrameStageStyle(frameDisplayMode, frameWidth, frameHeight, false)
  const viewerStageStyle = adaptiveFrameStageStyle(frameDisplayMode, frameWidth, frameHeight, true)

  useEffect(() => {
    if (!previewActive) {
      if (framePreviewUrlRef.current) {
        URL.revokeObjectURL(framePreviewUrlRef.current)
        framePreviewUrlRef.current = null
      }
      return undefined
    }

    let cancelled = false
    let timer: number | undefined

    async function refreshFrame() {
      try {
        const { blob, version } = await fetchCaptureFrame()
        if (cancelled) {
          return
        }

        if (version && version === framePreviewVersionRef.current) {
          timer = window.setTimeout(refreshFrame, 120)
          return
        }

        const nextUrl = URL.createObjectURL(blob)
        const previousUrl = framePreviewUrlRef.current
        framePreviewUrlRef.current = nextUrl
        framePreviewVersionRef.current = version || framePreviewVersionRef.current + 1
        setPreviewFrameVersion(framePreviewVersionRef.current)
        setFramePreviewUrl(nextUrl)
        setFramePreviewError('')
        if (previousUrl) {
          URL.revokeObjectURL(previousUrl)
        }
      } catch (error: unknown) {
        if (!cancelled) {
          setFramePreviewError(error instanceof Error ? error.message : String(error))
        }
      }

      if (!cancelled) {
        timer = window.setTimeout(refreshFrame, 120)
      }
    }

    void refreshFrame()

    return () => {
      cancelled = true
      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
    }
  }, [previewActive])

  useEffect(() => {
    return () => {
      if (framePreviewUrlRef.current) {
        URL.revokeObjectURL(framePreviewUrlRef.current)
        framePreviewUrlRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!viewerOpen) {
      return undefined
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setViewerOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [viewerOpen])

  function toggleFrameDisplayMode() {
    setFrameDisplayMode((current) => {
      const next = nextFrameDisplayMode(current)
      setFrameDisplayModePreference(next)
      return next
    })
  }

  return (
    <>
      <section className="frame-console panel">
        <div className="frame-toolbar">
          <div>
            <p className="eyebrow">Frame Input</p>
            <h2>{source}</h2>
          </div>
          <div className="frame-toolbar-actions">
            <button
              type="button"
              className={`icon-button frame-mode-button frame-mode-button-${frameDisplayMode}`}
              title={frameModeAction}
              aria-label={frameModeAction}
              aria-pressed={frameDisplayMode === 'adaptive'}
              onClick={toggleFrameDisplayMode}
            >
              {frameDisplayModeIcon(frameDisplayMode)}
            </button>
            <button
              type="button"
              className="icon-button"
              title={frameHudVisible ? '隐藏画面状态条' : '显示画面状态条'}
              aria-label={frameHudVisible ? '隐藏画面状态条' : '显示画面状态条'}
              onClick={() => setFrameHudVisible((current) => !current)}
            >
              {frameHudVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="icon-button"
              title="放大预览"
              aria-label="放大预览"
              onClick={() => setViewerOpen(true)}
              disabled={!visibleFramePreviewUrl}
            >
              <Maximize2 size={17} aria-hidden="true" />
            </button>
            <span className={`live-chip ${tone}`}>
              <Activity size={15} aria-hidden="true" />
              {captureStatus?.status ?? 'idle'}
            </span>
          </div>
        </div>

        <FrameStage
          ariaLabel="视频帧预览"
          detections={overlayDetections}
          displayMode={frameDisplayMode}
          displayFrameNumber={displayFrameNumber}
          emptyText={framePreviewError ? '视频帧预览读取失败' : '等待视频帧…'}
          frameHudVisible={frameHudVisible}
          frameHeight={frameHeight}
          framePreviewUrl={visibleFramePreviewUrl}
          frameWidth={frameWidth}
          model={model}
          overlayStatus={overlayStatus}
          queuedText={queuedText}
          style={previewStageStyle}
        />
      </section>

      {viewerOpen && (
        <div
          className="frame-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="放大视频帧预览"
          onClick={() => setViewerOpen(false)}
        >
          <div className="frame-lightbox-shell" onClick={(event) => event.stopPropagation()}>
            <div className="frame-lightbox-header">
              <div>
                <p className="eyebrow">Frame Viewer</p>
                <strong>{source}</strong>
              </div>
              <button
                type="button"
                className="icon-button"
                title="关闭放大预览"
                aria-label="关闭放大预览"
                onClick={() => setViewerOpen(false)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <FrameStage
              ariaLabel="放大视频帧预览"
              className="frame-lightbox-stage"
              detections={overlayDetections}
              displayMode={frameDisplayMode}
              displayFrameNumber={displayFrameNumber}
              emptyText="等待视频帧…"
              frameHudVisible={frameHudVisible}
              frameHeight={frameHeight}
              framePreviewUrl={visibleFramePreviewUrl}
              frameWidth={frameWidth}
              model={model}
              overlayStatus={overlayStatus}
              queuedText={queuedText}
              style={viewerStageStyle}
            />
          </div>
        </div>
      )}
    </>
  )
}

function FrameStage({
  ariaLabel,
  className = '',
  detections,
  displayMode,
  displayFrameNumber,
  emptyText,
  frameHudVisible,
  frameHeight,
  framePreviewUrl,
  frameWidth,
  model,
  overlayStatus,
  style,
  queuedText,
}: {
  ariaLabel: string
  className?: string
  detections: DetectionSnapshot[]
  displayMode: FrameDisplayMode
  displayFrameNumber: number
  emptyText: string
  frameHudVisible: boolean
  frameHeight: number
  framePreviewUrl: string
  frameWidth: number
  model: string
  overlayStatus: string
  style?: CSSProperties
  queuedText: string
}) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const detectionBoxes = detections
    .map((detection) => ({
      detection,
      style: detectionBoxStyle(detection, frameWidth, frameHeight, stageSize, displayMode),
    }))
    .filter((item): item is { detection: DetectionSnapshot; style: Record<string, string> } => Boolean(item.style))
    .slice(0, 6)
  const stageClassName = ['video-stage', `frame-mode-${displayMode}`, className, framePreviewUrl ? 'has-frame' : '']
    .filter(Boolean)
    .join(' ')

  useEffect(() => {
    const node = stageRef.current
    if (!node) {
      return undefined
    }
    const stageNode = node

    function updateStageSize() {
      const rect = stageNode.getBoundingClientRect()
      setStageSize((current) => {
        if (Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1) {
          return current
        }
        return { width: rect.width, height: rect.height }
      })
    }

    updateStageSize()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateStageSize)
      return () => window.removeEventListener('resize', updateStageSize)
    }

    const observer = new ResizeObserver(updateStageSize)
    observer.observe(stageNode)
    window.addEventListener('resize', updateStageSize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateStageSize)
    }
  }, [])

  return (
    <div className={stageClassName} aria-label={ariaLabel} ref={stageRef} style={style}>
      {framePreviewUrl && (
        <img
          alt=""
          className="video-frame"
          src={framePreviewUrl}
        />
      )}
      <div className="scan-grid" aria-hidden="true" />
      <div className="frame-meta top-left">
        <span>FRAME</span>
        <strong>{String(displayFrameNumber).padStart(6, '0')}</strong>
      </div>
      <div className="frame-meta top-right">
        <span>MODEL</span>
        <strong>{model}</strong>
      </div>
      {detectionBoxes.map(({ detection, style }, index) => (
        <div
          className={`bbox ${index % 2 === 1 ? 'bbox-alt' : ''}`}
          key={`${ariaLabel}-${detection.frame_index ?? 'frame'}-${detection.object_class}-${index}`}
          style={style}
        >
          <span>{formatDetectionLabel(detection)}</span>
        </div>
      ))}
      {!framePreviewUrl && (
        <div className="stage-empty">
          {emptyText}
        </div>
      )}
      {frameHudVisible && (
        <div className="frame-footer">
          <span>{overlayStatus}</span>
          <span>{queuedText}</span>
        </div>
      )}
    </div>
  )
}

function PipelineMap({
  videoCheck,
  inferenceCheck,
  databaseCheck,
  spoolCheck,
}: {
  videoCheck?: EnvironmentCheck
  inferenceCheck?: EnvironmentCheck
  databaseCheck?: EnvironmentCheck
  spoolCheck?: EnvironmentCheck
}) {
  const nodes = [
    { label: 'Edge 拉流', detail: videoCheck?.message ?? 'HTTP MJPEG / RTSP / RTMP', icon: Video, status: videoCheck?.status },
    { label: 'GPU 推理', detail: inferenceCheck?.message ?? '本地或远端 API', icon: Zap, status: inferenceCheck?.status },
    { label: 'SQLite 缓存', detail: spoolCheck?.message ?? 'spool 批量缓冲', icon: ArrowDownUp, status: spoolCheck?.status },
    { label: 'TimescaleDB', detail: databaseCheck?.message ?? '时序写库', icon: Database, status: databaseCheck?.status },
  ]

  return (
    <section className="pipeline-map panel">
      <PanelHeading eyebrow="Processing Chain" title="可拆分部署链路" icon={Layers3} compact />
      <div className="chain">
        {nodes.map((node, index) => {
          const Icon = node.icon
          return (
            <div className="chain-row" key={node.label}>
              <span className={`chain-icon ${node.status ?? 'warn'}`}>
                <Icon size={18} aria-hidden="true" />
              </span>
              <div>
                <strong>{node.label}</strong>
                <span>{node.detail}</span>
              </div>
              {index < nodes.length - 1 && <i aria-hidden="true" />}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function SignalCard({
  icon: Icon,
  label,
  check,
  fallback,
}: {
  icon: typeof Activity
  label: string
  check?: EnvironmentCheck
  fallback: string
}) {
  const tone = check?.status ?? 'warn'
  const message = check?.message ?? fallback

  return (
    <article className={`signal-card ${tone}`} title={`${label}: ${message}`}>
      <div className="signal-icon">
        <Icon size={18} aria-hidden="true" />
      </div>
      <div>
        <p>{label}</p>
        <strong>{message}</strong>
      </div>
      <span className={`dot ${tone}`} aria-hidden="true" />
    </article>
  )
}

function OverviewPage({
  checks,
  summaryChart,
  spoolChart,
  analysisSummary,
  captureStatus,
}: {
  checks: EnvironmentCheck[]
  summaryChart: Array<{ name: CheckStatus; value: number }>
  spoolChart: Array<{ name: string; value: number }>
  analysisSummary?: AnalysisSummary
  captureStatus?: CaptureStatus
}) {
  const recentDetections = captureStatus?.recent_detections ?? []

  return (
    <section className="workspace">
      <div className="panel primary-panel">
        <PanelHeading eyebrow="Runtime" title="采集和推理吞吐" icon={Gauge} />
        <div className="metric-grid">
          <Metric label="读取帧" value={captureStatus?.frames_read ?? 0} />
          <Metric label="推理帧" value={captureStatus?.frames_inferred ?? 0} />
          <Metric label="入队检测" value={captureStatus?.detections_queued ?? 0} />
          <Metric label="最近检测" value={recentDetections.length} />
        </div>
      </div>

      <aside className="panel side-panel">
        <PanelHeading eyebrow="Health" title="环境状态" icon={Activity} compact />
        <div className="chart-box radial-chart">
          <ResponsiveContainer width="100%" height={176}>
            <PieChart>
              <Pie data={summaryChart} dataKey="value" nameKey="name" innerRadius={50} outerRadius={72}>
                {summaryChart.map((entry) => (
                  <Cell fill={statusColors[entry.name]} key={entry.name} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </aside>

      <div className="panel full-span">
        <PanelHeading eyebrow="Diagnostics" title="运行环境检测" icon={ListChecks} compact />
        <table className="data-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>状态</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check) => (
              <tr key={check.name}>
                <td>{check.name}</td>
                <td>
                  <span className={`mini-status ${check.status}`}>{check.status}</span>
                </td>
                <td>{check.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel full-span">
        <PanelHeading eyebrow="Spool" title="缓存写库分布" icon={ArrowDownUp} compact />
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={spoolChart}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" fill="#2f6fed" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="panel full-span">
        <PanelHeading eyebrow="Recent" title="最近检测快照" icon={ScanLine} compact />
        <DetectionTable detections={recentDetections} emptyText={analysisSummary?.message ?? '暂无检测记录'} />
      </div>
    </section>
  )
}

function ConfigPage({
  config,
  videoConfig,
  inferenceStatus,
  onProbe,
  probePending,
  probeResult,
  onProbeConfig,
  configProbePending,
  configProbeResult,
  configProbeError,
  onSave,
  savePending,
  saveResult,
  saveError,
  onRemoteAction,
  remotePending,
  remoteResult,
  remoteError,
}: {
  config?: Record<string, unknown>
  videoConfig?: VideoConfig
  inferenceStatus?: InferenceStatus
  onProbe: () => void
  probePending: boolean
  probeResult?: Record<string, unknown>
  onProbeConfig: (values: Record<string, ConfigValue>) => void
  configProbePending: boolean
  configProbeResult?: EnvironmentResponse
  configProbeError?: string
  onSave: (values: Record<string, ConfigValue>) => Promise<ActionResponse>
  savePending: boolean
  saveResult?: Record<string, unknown>
  saveError?: string
  onRemoteAction: (action: RemoteAction, payload?: { remote_db_password?: string }) => void
  remotePending: boolean
  remoteResult?: Record<string, unknown>
  remoteError?: string
}) {
  const currentDraft = useMemo(() => buildConfigDraft(config, videoConfig), [config, videoConfig])
  const [draft, setDraft] = useState<ConfigDraft>({})
  const [dirty, setDirty] = useState(false)
  const [remoteDbPassword, setRemoteDbPassword] = useState('')
  const [revealedFields, setRevealedFields] = useState<Set<string>>(() => new Set())
  const [activeConfigSection, setActiveConfigSection] = useState<ConfigSectionKey>('access')
  const visibleDraft = dirty ? draft : currentDraft
  const serverTokenConfigured = Boolean((visibleDraft.API_AUTH_TOKEN ?? '').trim())
  const accessMessage = serverTokenConfigured
    ? '服务端已启用鉴权，除健康检查外的 API 都需要 Bearer token。'
    : '服务端未启用接口鉴权；填写 token 后保存即可开启。'

  useEffect(() => {
    if (!dirty) {
      return undefined
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [dirty])

  function updateField(key: string, value: string) {
    setDraft((current) => {
      const next = { ...(dirty ? current : currentDraft), [key]: value }
      if (key === 'STREAM_MODE' && value === 'push' && !['rtsp', 'rtmp'].includes(next.STREAM_PROTOCOL ?? '')) {
        next.STREAM_PROTOCOL = 'rtmp'
      }
      return next
    })
    setDirty(true)
  }

  function saveConfig() {
    void onSave(collectConfigValues(visibleDraft, currentDraft))
      .then((result) => {
        if (result.status === 'ok') {
          setDraft({})
          setDirty(false)
        }
      })
      .catch(() => undefined)
  }

  function runRemote(action: RemoteAction) {
    const payload =
      action === 'configure_database' && remoteDbPassword
        ? { remote_db_password: remoteDbPassword }
        : undefined
    onRemoteAction(action, payload)
  }

  function toggleSensitiveField(key: string) {
    setRevealedFields((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  function renderConfigField(field: ConfigField, className?: string) {
    return (
      <ConfigFieldControl
        className={className}
        config={config}
        field={field}
        key={field.key}
        locked={lockedConfigKeys.has(field.key)}
        revealed={revealedFields.has(field.key)}
        value={visibleDraft[field.key] ?? ''}
        onChange={updateField}
        onReveal={toggleSensitiveField}
      />
    )
  }

  const saveMessage = saveError ?? formatSaveResult(saveResult)
  const remoteOutput = remoteError ?? formatRemoteOutput(remoteResult)
  const configProbeMessage = configProbeError ?? formatProbeSummary(configProbeResult)
  const configProbeChecks = configProbeResult?.checks ?? []
  const remoteConfig = pickObject(config, 'remote')
  const sshConfigured = Boolean(remoteConfig.ssh_configured)
  const activeConfigTab =
    configSectionTabs.find((tab) => tab.key === activeConfigSection) ?? configSectionTabs[0]

  function renderWorkflowGroup(group: ConfigGroup, full = true) {
    const Icon = group.icon

    return (
      <div className={`panel config-card ${group.accent} ${full ? 'full-config' : ''}`} key={group.title}>
        <PanelHeading eyebrow={group.eyebrow} title={group.title} icon={Icon} />
        <div className="field-grid">
          {group.fields.map((field) => renderConfigField(field))}
        </div>
        {group.title === '推理配置' && (
          <div className={`notice ${inferenceStatus?.status ?? 'warn'}`}>
            {inferenceStatus?.message ?? '推理状态检测中…'}
          </div>
        )}
      </div>
    )
  }

  function renderWorkflowGroupByTitle(title: string, full = true) {
    const group = workflowConfigGroups.find((item) => item.title === title)
    return group ? renderWorkflowGroup(group, full) : null
  }

  function renderAccessPanel() {
    return (
      <div className="panel access-panel full-config">
        <PanelHeading eyebrow={accessConfigGroup.eyebrow} title={accessConfigGroup.title} icon={ShieldCheck} />

        <div className="security-focus">
          <div className="security-focus-head">
            <div>
              <p className="eyebrow">Server Rule</p>
              <h3>服务端接口保护</h3>
            </div>
            <span className={`mini-status ${serverTokenConfigured ? 'ok' : 'warn'}`}>
              {serverTokenConfigured ? '已启用' : '未启用'}
            </span>
          </div>
          <div className={`notice ${serverTokenConfigured ? 'ok' : 'warn'}`}>{accessMessage}</div>
          <div className="field-grid security-fields">
            {accessConfigGroup.fields.map((field) => renderConfigField(field))}
          </div>
        </div>
      </div>
    )
  }

  function renderRemoteOpsPanel() {
    return (
      <div className="panel config-card accent-remote remote-panel full-config">
        <PanelHeading eyebrow="Remote Ops" title="远端与数据库管理" icon={Server} />
        <div className={`notice ${sshConfigured ? 'ok' : 'warn'}`}>
          {sshConfigured
            ? 'SSH 已配置，仅用于远端检测、同步、安装、配库和启停 API。'
            : 'SSH 未配置；数据库、schema 应用和推理 API 仍可通过直连 URL 使用。'}
        </div>
        <div className="remote-password-row">
          <div className="config-field">
            <div className="field-head">
              <label htmlFor="remote-database-password">SSH 配库密码（可选）</label>
              <small className={remoteDbPassword ? 'set' : 'empty'}>
                {remoteDbPassword ? '已填写' : '未填写'}
              </small>
            </div>
            <input
              autoComplete="off"
              id="remote-database-password"
              inputMode="text"
              name="REMOTE_DATABASE_PASSWORD"
              spellCheck={false}
              type="password"
              value={remoteDbPassword}
              placeholder="留空自动生成或使用脚本默认值…"
              onChange={(event) => setRemoteDbPassword(event.target.value)}
            />
            <p className="field-hint">
              只在使用 SSH 自动配置数据库时发送；普通数据库连接仍使用 DATABASE_URL。
            </p>
          </div>
        </div>
        <div className="remote-action-grid">
          {remoteActions.map((item) => {
            const Icon = item.icon
            return (
              <button
                type="button"
                key={item.action}
                onClick={() => runRemote(item.action)}
                disabled={remotePending}
              >
                <Icon size={17} aria-hidden="true" />
                {item.label}
              </button>
            )
          })}
        </div>
        <pre className="terminal-output" aria-live="polite">{remoteOutput || '等待远端操作…'}</pre>
      </div>
    )
  }

  function renderActiveConfigSection() {
    switch (activeConfigSection) {
      case 'access':
        return renderAccessPanel()
      case 'video':
        return (
          <VideoAccessPanel
            mode={visibleDraft.STREAM_MODE === 'push' ? 'push' : 'pull'}
            probePending={probePending}
            probeResult={probeResult}
            supportedPushProtocols={videoConfig?.supported_push_protocols ?? ['rtsp', 'rtmp']}
            renderConfigField={renderConfigField}
            onProbe={onProbe}
          />
        )
      case 'inference':
        return renderWorkflowGroupByTitle('推理配置')
      case 'storage':
        return renderWorkflowGroupByTitle('数据库与缓存')
      case 'observability':
        return (
          <>
            {renderWorkflowGroupByTitle('分析视图', false)}
            {renderWorkflowGroupByTitle('可观测性', false)}
          </>
        )
      case 'remote':
        return (
          <>
            {renderWorkflowGroupByTitle('远端管理')}
            {renderRemoteOpsPanel()}
          </>
        )
      default:
        return renderAccessPanel()
    }
  }

  return (
    <section className="config-layout config-editable">
      <div className="panel config-section-nav full-config">
        <div className="config-section-current">
          <p className="eyebrow">{activeConfigTab.eyebrow}</p>
          <h2>{activeConfigTab.label}配置</h2>
        </div>
        <div className="config-section-tabs" role="tablist" aria-label="配置分页">
          {configSectionTabs.map((tab, index) => {
            const Icon = tab.icon
            const active = tab.key === activeConfigSection

            return (
              <button
                aria-selected={active}
                className={active ? 'active' : ''}
                key={tab.key}
                role="tab"
                type="button"
                onClick={() => setActiveConfigSection(tab.key)}
              >
                <span className="config-section-index">{index + 1}</span>
                <Icon size={16} aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {renderActiveConfigSection()}

      <div className="panel config-toolbar full-config">
        <div>
          <p className="eyebrow">Apply</p>
          <h2>{dirty ? '有未保存配置' : '配置已同步'}</h2>
        </div>
        <div className="action-row">
          <button
            type="button"
            onClick={() => onProbeConfig(collectProbeValues(visibleDraft))}
            disabled={configProbePending || !config}
          >
            <ShieldCheck size={17} aria-hidden="true" />
            检测当前配置
          </button>
          <button type="button" onClick={saveConfig} disabled={savePending || !dirty}>
            <Save size={17} aria-hidden="true" />
            保存并热重载
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft({})
              setDirty(false)
            }}
            disabled={!dirty || savePending}
          >
            <RotateCw size={17} aria-hidden="true" />
            还原
          </button>
          {saveMessage && <span className={`action-result ${saveError ? 'error' : ''}`} aria-live="polite">{saveMessage}</span>}
          {configProbeMessage && <span className={`action-result ${configProbeError ? 'error' : ''}`} aria-live="polite">{configProbeMessage}</span>}
        </div>
        {configProbeChecks.length > 0 && (
          <div className="probe-strip" aria-label="当前配置检测结果">
            {configProbeChecks.map((check) => (
              <span className={`mini-status ${check.status}`} key={check.name}>
                {check.name}: {check.status}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function VideoAccessPanel({
  mode,
  supportedPushProtocols,
  probePending,
  probeResult,
  renderConfigField,
  onProbe,
}: {
  mode: 'pull' | 'push'
  supportedPushProtocols: string[]
  probePending: boolean
  probeResult?: Record<string, unknown>
  renderConfigField: (field: ConfigField, className?: string) => ReactNode
  onProbe: () => void
}) {
  const isPush = mode === 'push'
  const modeFields = isPush ? pushVideoFields : pullVideoFields
  const credentialFields = isPush ? pushCredentialFields : pullCredentialFields

  return (
    <div className={`panel config-card accent-video video-access-card full-config mode-${mode}`}>
      <PanelHeading eyebrow={videoAccessConfigGroup.eyebrow} title={videoAccessConfigGroup.title} icon={Video} />

      <div className="video-mode-shell">
        <div className="video-mode-select">
          {renderConfigField(streamModeField)}
        </div>
        <div className="video-mode-summary" aria-live="polite">
          <span>{isPush ? '接收推流模式' : '主动拉流模式'}</span>
          <strong>
            {isPush
              ? '设备先推到接收器，后端再从播放地址读取帧。'
              : '后端直接从手机、摄像头、文件或网络流读取帧。'}
          </strong>
        </div>
      </div>

      <div className="video-access-grid">
        <section className="video-config-section">
          <div className="section-head">
            <p className="eyebrow">{isPush ? 'Push Receiver' : 'Pull Source'}</p>
            <h3>{isPush ? '接收推流' : '拉流输入'}</h3>
          </div>
          <div className="field-grid">
            {modeFields.map((field) => renderConfigField(field))}
          </div>
        </section>

        <section className="video-config-section">
          <div className="section-head">
            <p className="eyebrow">Credentials</p>
            <h3>访问凭证</h3>
          </div>
          <div className="field-grid">
            {credentialFields.map((field) => renderConfigField(field))}
          </div>
          <div className="tag-row">
            {(isPush ? supportedPushProtocols : ['http_mjpeg', 'rtsp', 'rtmp', 'camera', 'file']).map((item) => (
              <span className="tag" key={item}>{item}</span>
            ))}
          </div>
        </section>
      </div>

      <div className="video-meta-row">
        <div className="field-grid">
          {captureMetaFields.map((field) => renderConfigField(field))}
        </div>
      </div>

      <div className="action-row">
        <button type="button" onClick={onProbe} disabled={probePending}>
          <Play size={17} aria-hidden="true" />
          检测视频配置
        </button>
        {probeResult && (
          <span className="action-result" aria-live="polite">{String(probeResult.message ?? probeResult.status)}</span>
        )}
      </div>
    </div>
  )
}

function TasksPage({
  captureStatus,
  spoolStatus,
  onStart,
  onStop,
  startPending,
  stopPending,
  startResult,
  stopResult,
  onFlush,
  flushPending,
  flushResult,
}: {
  captureStatus?: CaptureStatus
  spoolStatus?: SpoolStatus
  onStart: () => void
  onStop: () => void
  startPending: boolean
  stopPending: boolean
  startResult?: Record<string, unknown>
  stopResult?: Record<string, unknown>
  onFlush: () => void
  flushPending: boolean
  flushResult?: Record<string, unknown>
}) {
  return (
    <section className="workspace">
      <div className="panel primary-panel">
        <PanelHeading eyebrow="Capture" title="采集任务控制" icon={ListChecks} />
        <div className="metric-grid">
          <Metric label="状态" value={captureStatus?.status ?? 'idle'} />
          <Metric label="读取帧" value={captureStatus?.frames_read ?? 0} />
          <Metric label="推理帧" value={captureStatus?.frames_inferred ?? 0} />
          <Metric label="检测入队" value={captureStatus?.detections_queued ?? 0} />
        </div>
        <div className="action-row">
          <button type="button" onClick={onStart} disabled={startPending || captureStatus?.status === 'running'}>
            <Play size={17} aria-hidden="true" />
            启动采集
          </button>
          <button type="button" onClick={onStop} disabled={stopPending || captureStatus?.status !== 'running'}>
            <Square size={17} aria-hidden="true" />
            停止采集
          </button>
          {startResult && <span className="action-result" aria-live="polite">{String(startResult.message ?? startResult.status)}</span>}
          {stopResult && <span className="action-result" aria-live="polite">{String(stopResult.message ?? stopResult.status)}</span>}
        </div>
      </div>

      <aside className="panel side-panel">
        <PanelHeading eyebrow="Locked" title="运行中锁定配置" icon={ShieldCheck} compact />
        <KeyValueGrid data={captureStatus?.settings_locked ?? {}} />
      </aside>

      <div className="panel full-span">
        <PanelHeading eyebrow="Spool" title="异步写库队列" icon={ArrowDownUp} compact />
        <div className="metric-grid">
          <Metric label="内存队列" value={spoolStatus?.memory_queue_size ?? 0} />
          <Metric label="待写入" value={spoolStatus?.counts.pending ?? 0} />
          <Metric label="已同步" value={spoolStatus?.counts.synced ?? 0} />
          <Metric label="失败" value={spoolStatus?.counts.failed ?? 0} />
        </div>
        <div className="action-row">
          <button type="button" onClick={onFlush} disabled={flushPending}>
            <ArrowDownUp size={17} aria-hidden="true" />
            批量写库
          </button>
          {flushResult && <span className="action-result" aria-live="polite">{String(flushResult.status)}</span>}
        </div>
      </div>
    </section>
  )
}

function AnalysisPage({
  config,
  analysisSummary,
  topClassChart,
  bucketChart,
}: {
  config?: Record<string, unknown>
  analysisSummary?: AnalysisSummary
  topClassChart: Array<{ name: string; value: number }>
  bucketChart: Array<{ name: string; value: number }>
}) {
  const inference = pickObject(config, 'inference')
  const analysis = pickObject(config, 'analysis')
  const classFilter = String(inference.class_filter || '全部类别')
  const timeRange = Number(analysis.time_range_minutes || 30)
  const recent = analysisSummary?.recent ?? []
  const resultMeta = analysisSummary?.result_meta ?? []

  return (
    <section className="workspace">
      <div className="panel primary-panel sql-panel">
        <PanelHeading eyebrow="Timescale SQL" title="时序分析查询" icon={BarChart3} />
        <div className="metric-grid analysis-settings">
          <Metric label="时间范围" value={`${timeRange} 分钟`} />
          <Metric label="类别过滤" value={classFilter} />
          <Metric label="查询状态" value={analysisSummary?.status ?? 'loading'} />
          <Metric label="统计元数据" value={resultMeta.length} />
        </div>
        {analysisSummary?.status !== 'ok' && (
          <div className={`notice ${analysisSummary?.status === 'error' ? 'error' : 'warn'}`}>
            {analysisSummary?.message ?? '等待分析数据…'}
          </div>
        )}
        <ol className="query-list">
          {analysisQueries.map((query) => (
            <li key={query}>{query}</li>
          ))}
        </ol>
      </div>

      <aside className="panel side-panel">
        <PanelHeading eyebrow="Top Classes" title="类别分布" icon={ShieldCheck} compact />
        <ResponsiveContainer width="100%" height={176}>
          <BarChart data={topClassChart}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" fill="#0f9f77" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </aside>

      <div className="panel full-span">
        <PanelHeading eyebrow="Timeline" title="检测时间桶" icon={Database} compact />
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={bucketChart}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="value" fill="#0f9f77" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="panel full-span">
        <PanelHeading eyebrow="Result Meta" title="统计元数据" icon={Layers3} compact />
        <ResultMetaTable rows={resultMeta} emptyText={analysisSummary?.message ?? '暂无统计元数据'} />
      </div>

      <div className="panel full-span">
        <PanelHeading eyebrow="Recent" title="最近写入记录" icon={ListChecks} compact />
        <DetectionTable detections={recent} emptyText={analysisSummary?.message ?? '暂无数据库记录'} />
      </div>
    </section>
  )
}

function LogsPage({
  apiKeySalt,
  captureStatus,
}: {
  apiKeySalt: string
  captureStatus?: CaptureStatus
}) {
  const queryClient = useQueryClient()
  const [activePane, setActivePane] = useState<LogPaneKey>('runtime')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [levelFilter, setLevelFilter] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [errorOnly, setErrorOnly] = useState(false)
  const [newestFirst, setNewestFirst] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [maxFramesDraft, setMaxFramesDraft] = useState('120')
  const [clearSpool, setClearSpool] = useState(true)
  const [clearTimescale, setClearTimescale] = useState(false)
  const [clearConfirm, setClearConfirm] = useState('')
  const [selectedQueryId, setSelectedQueryId] = useState('')
  const logEndRef = useRef<HTMLDivElement | null>(null)
  const runningCapture = captureStatus?.status === 'running' || captureStatus?.status === 'stopping'

  const logEvents = useQuery({
    queryKey: ['ui-log-events', apiKeySalt, sourceFilter, levelFilter, keyword, errorOnly],
    queryFn: () =>
      fetchLogEvents({
        source: sourceFilter === 'all' ? '' : sourceFilter,
        level: errorOnly ? 'error' : levelFilter === 'all' ? '' : levelFilter,
        q: keyword,
        limit: 400,
      }),
    refetchInterval: 2_000,
  })

  const writeRun = useQuery({
    queryKey: ['write-run-status', apiKeySalt],
    queryFn: fetchWriteRunStatus,
    refetchInterval: 1_000,
  })

  const analysisQueries = useQuery({
    queryKey: ['analysis-log-queries', apiKeySalt],
    queryFn: fetchAnalysisQueries,
  })
  const availableQueries = analysisQueries.data?.queries ?? []
  const selectedQuery = availableQueries.find((query) => String(query.id) === selectedQueryId) ?? availableQueries[0]

  const startRun = useMutation({
    mutationFn: (inputMode: WriteRunInputMode) =>
      startWriteRun({
        input_mode: inputMode,
        max_frames: boundedInteger(maxFramesDraft, 120, 1, 10_000),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
    },
  })

  const stopRun = useMutation({
    mutationFn: stopWriteRun,
    onSuccess: () => {
      void queryClient.invalidateQueries()
    },
  })

  const runQueries = useMutation({
    mutationFn: () =>
      runAnalysisQueries({
        query_ids: selectedQuery ? [selectedQuery.id] : [],
        row_limit: 80,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ui-log-events'] })
    },
  })

  const clearLogs = useMutation({
    mutationFn: clearLogEvents,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ui-log-events'] })
    },
  })

  const clearData = useMutation({
    mutationFn: () =>
      clearRuntimeData({
        clear_spool: clearSpool,
        clear_timescale: clearTimescale,
        confirm: clearConfirm,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries()
    },
  })

  const events = logEvents.data?.events ?? []
  const visibleEvents = newestFirst ? [...events].reverse() : events
  const currentRun = writeRun.data?.run
  const runActive = currentRun?.status === 'running' || currentRun?.status === 'stopping'
  const analysisResult = runQueries.data
  const queryCards = analysisResult?.results ?? []
  const selectedResult = selectedQuery
    ? queryCards.find((result) => result.id === selectedQuery.id)
    : queryCards[0]
  const canClearData = clearSpool || clearTimescale
  const actionMessage = String(
    startRun.error?.message
      ?? stopRun.error?.message
      ?? runQueries.error?.message
      ?? clearLogs.error?.message
      ?? clearData.error?.message
      ?? startRun.data?.message
      ?? stopRun.data?.message
      ?? analysisResult?.message
      ?? clearLogs.data?.message
      ?? clearData.data?.message
      ?? '',
  )
  const actionMessageIsError = Boolean(
    startRun.error
      || stopRun.error
      || runQueries.error
      || clearLogs.error
      || clearData.error
      || analysisResult?.status === 'error'
      || clearData.data?.status === 'error'
      || clearData.data?.status === 'blocked',
  )

  useEffect(() => {
    if (autoScroll && !newestFirst) {
      logEndRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [autoScroll, newestFirst, events.length])

  return (
    <section className="logs-workspace terminal-first-workspace">
      <div className="log-console-shell">
        <header className="log-console-header">
          <div>
            <span className="console-kicker">视频检测运行台</span>
            <h2>日志终端</h2>
          </div>
          <div className="console-situation" aria-label="情况日志">
            <span>采集：{statusLabel(captureStatus?.status ?? 'idle')}</span>
            <span>流程：{statusLabel(currentRun?.status ?? 'idle')}</span>
            <span>帧数：{numberFormatter.format(captureStatus?.frames_read ?? 0)}</span>
            <span>入队：{numberFormatter.format(captureStatus?.detections_queued ?? 0)}</span>
          </div>
        </header>

        <div className="log-console-tabs" role="tablist" aria-label="日志视图">
          {logPanes.map((pane) => {
            const Icon = pane.icon
            return (
              <button
                type="button"
                role="tab"
                aria-selected={activePane === pane.key}
                className={activePane === pane.key ? 'active' : ''}
                key={pane.key}
                onClick={() => setActivePane(pane.key)}
              >
                <Icon size={17} aria-hidden="true" />
                {pane.label}
              </button>
            )
          })}
        </div>

        {activePane === 'runtime' && (
          <div className="terminal-command-row">
            <label>
              <span>来源</span>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                {logSourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>级别</span>
              <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}>
                {logLevelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="terminal-search-field">
              <span>关键词</span>
              <input
                inputMode="search"
                type="search"
                value={keyword}
                placeholder="事件、消息、状态"
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <label className="terminal-check">
              <input
                type="checkbox"
                checked={errorOnly}
                onChange={(event) => setErrorOnly(event.target.checked)}
              />
              只看错误
            </label>
            <label className="terminal-check">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(event) => setAutoScroll(event.target.checked)}
              />
              跟随最新
            </label>
            <button type="button" onClick={() => setNewestFirst((current) => !current)}>
              <ArrowDownUp size={16} aria-hidden="true" />
              {newestFirst ? '倒序' : '正序'}
            </button>
          </div>
        )}

        {activePane === 'write' && (
          <div className="terminal-command-row">
            <label>
              <span>帧数</span>
              <input
                inputMode="numeric"
                min={1}
                max={10000}
                type="number"
                value={maxFramesDraft}
                onChange={(event) => setMaxFramesDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => startRun.mutate('live')}
              disabled={startRun.isPending || runActive || runningCapture}
            >
              <Video size={16} aria-hidden="true" />
              实时视频写入
            </button>
            <button
              type="button"
              onClick={() => startRun.mutate('sample')}
              disabled={startRun.isPending || runActive}
            >
              <Play size={16} aria-hidden="true" />
              样例输入写入
            </button>
            <button
              type="button"
              onClick={() => stopRun.mutate()}
              disabled={stopRun.isPending || !runActive}
            >
              <Square size={16} aria-hidden="true" />
              停止
            </button>
          </div>
        )}

        {activePane === 'analysis' && (
          <div className="terminal-command-row">
            <label className="terminal-search-field">
              <span>查询语句</span>
              <select
                value={selectedQuery ? String(selectedQuery.id) : ''}
                onChange={(event) => setSelectedQueryId(event.target.value)}
              >
                {availableQueries.map((query) => (
                  <option key={query.id} value={query.id}>
                    {query.id}. {cleanQueryTitle(query.title)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => runQueries.mutate()}
              disabled={runQueries.isPending || !selectedQuery}
            >
              <Database size={16} aria-hidden="true" />
              执行当前查询
            </button>
            <button
              type="button"
              onClick={() => startRun.mutate('sample')}
              disabled={startRun.isPending || runActive}
            >
              <Play size={16} aria-hidden="true" />
              先写入样例输入
            </button>
            <span className="terminal-inline-stat">{availableQueries.length} 个查询</span>
            <span className={`mini-status ${statusClassName(analysisResult?.status ?? 'info')}`}>
              {analysisStatusLabel(analysisResult?.status ?? 'ready')}
            </span>
          </div>
        )}

        {activePane === 'maintenance' && (
          <div className="terminal-command-row maintenance-row">
            <button
              type="button"
              onClick={() => clearLogs.mutate()}
              disabled={clearLogs.isPending}
            >
              <Trash2 size={16} aria-hidden="true" />
              清空日志
            </button>
            <label className="terminal-check">
              <input
                type="checkbox"
                checked={clearSpool}
                onChange={(event) => setClearSpool(event.target.checked)}
              />
              SQLite 缓存
            </label>
            <label className="terminal-check">
              <input
                type="checkbox"
                checked={clearTimescale}
                onChange={(event) => setClearTimescale(event.target.checked)}
              />
              TimescaleDB 记录
            </label>
            <label className="terminal-search-field">
              <span>确认码</span>
              <input
                value={clearConfirm}
                placeholder="输入 CLEAR_DATA 后可清空数据库记录"
                onChange={(event) => setClearConfirm(event.target.value)}
              />
            </label>
            {clearTimescale && clearConfirm !== 'CLEAR_DATA' && (
              <span className="terminal-inline-warning">需要确认码 CLEAR_DATA</span>
            )}
            <button
              type="button"
              onClick={() => clearData.mutate()}
              disabled={clearData.isPending || !canClearData}
            >
              <HardDrive size={16} aria-hidden="true" />
              清空数据
            </button>
          </div>
        )}

        {actionMessage && (
          <div className={`console-action-message ${actionMessageIsError ? 'error' : 'ok'}`}>
            {actionMessage}
          </div>
        )}

        <div className="terminal-log" aria-live="polite">
          {logEvents.isError && <div className="terminal-empty">{logEvents.error.message}</div>}
          {!logEvents.isError && !visibleEvents.length && <div className="terminal-empty">等待运行日志...</div>}
          {visibleEvents.map((event) => (
            <LogEventRow event={event} key={event.id} />
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {activePane === 'analysis' && (
        <div className="analysis-console-results">
          <div className="analysis-console-head">
            <span>查询语句与结果</span>
            <strong>{selectedResult ? '已执行' : '待执行'}</strong>
          </div>
          {!selectedResult && selectedQuery && (
            <article className="query-result-card">
              <div className="query-result-head">
                <strong>查询 {selectedQuery.id} · {cleanQueryTitle(selectedQuery.title)}</strong>
                <span className="mini-status warn">待执行</span>
              </div>
              <pre className="sql-code">{selectedQuery.sql}</pre>
            </article>
          )}
          {selectedResult && (
            <SqlResultCard result={selectedResult} />
          )}
        </div>
      )}
    </section>
  )
}

function LogEventRow({ event }: { event: UiLogEvent }) {
  return (
    <article className={`log-event-row ${event.level}`}>
      <div className="log-event-meta">
        <span>{formatDateTime(event.time)}</span>
        <span className="terminal-level">[{logLevelLabel(event.level)}]</span>
        <span>{logSourceLabel(event.source)}</span>
      </div>
      <p>{event.message}</p>
      {Object.keys(event.details ?? {}).length > 0 && (
        <details>
          <summary>详情</summary>
          <pre>{formatLogDetails(event.details)}</pre>
        </details>
      )}
    </article>
  )
}

function SqlResultCard({ result }: { result: AnalysisQueryResult }) {
  const columns = result.columns.length
    ? result.columns
    : Array.from(new Set(result.rows.flatMap((row) => Object.keys(row))))

  return (
    <article className={`query-result-card ${result.status}`}>
      <div className="query-result-head">
        <strong>查询 {result.id} · {cleanQueryTitle(result.title)}</strong>
        <span className={`mini-status ${statusClassName(result.status)}`}>{analysisStatusLabel(result.status)}</span>
      </div>
      <pre className="sql-code">{result.sql}</pre>
      {result.error && <div className="notice error">{result.error}</div>}
      {result.warnings?.map((warning) => (
        <div className="notice warn" key={warning}>{warning}</div>
      ))}
      {!result.error && !result.rows.length && <div className="notice warn">查询完成，当前时间窗口暂无记录</div>}
      {!!result.rows.length && (
        <div className="result-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={`${result.id}-${rowIndex}`}>
                  {columns.map((column) => (
                    <td key={column}>{formatValue(row[column])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="query-result-foot">
        <span>{numberFormatter.format(result.row_count)} 行</span>
        {result.truncated && <span>已截取部分结果</span>}
      </div>
    </article>
  )
}

function ResultMetaTable({
  rows,
  emptyText,
}: {
  rows: AnalysisSummary['result_meta']
  emptyText: string
}) {
  if (!rows.length) {
    return <div className="notice warn">{emptyText}</div>
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>统计时间</th>
          <th>任务</th>
          <th>类别</th>
          <th>平均置信度</th>
          <th>数量</th>
          <th>窗口</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item, index) => (
          <tr key={`${item.stat_time}-${item.task_id}-${item.object_class}-${index}`}>
            <td>{formatDateTime(item.stat_time)}</td>
            <td>{item.task_id}</td>
            <td>{item.object_class}</td>
            <td>{formatConfidence(item.avg_confidence)}</td>
            <td>{numberFormatter.format(item.total_count)}</td>
            <td>{numberFormatter.format(item.stat_window_seconds)} 秒</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DetectionTable({
  detections,
  emptyText,
}: {
  detections: DetectionSnapshot[]
  emptyText: string
}) {
  if (!detections.length) {
    return <div className="notice warn">{emptyText}</div>
  }

  return (
    <table className="data-table detection-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>类别</th>
          <th>置信度</th>
          <th>帧</th>
          <th>推理端</th>
        </tr>
      </thead>
      <tbody>
        {detections.map((item, index) => (
          <tr key={`${item.time}-${item.object_class}-${index}`}>
            <td>{formatDateTime(item.time)}</td>
            <td>{item.object_class}</td>
            <td>{formatConfidence(item.confidence)}</td>
            <td>{item.frame_index ?? '-'}</td>
            <td>{item.inference_device ?? '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{typeof value === 'number' ? numberFormatter.format(value) : value}</strong>
    </div>
  )
}

function PanelHeading({
  eyebrow,
  title,
  icon: Icon,
  compact = false,
}: {
  eyebrow: string
  title: string
  icon: typeof Activity
  compact?: boolean
}) {
  return (
    <div className={`panel-heading ${compact ? 'compact' : ''}`}>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <Icon size={22} aria-hidden="true" />
    </div>
  )
}

function ConfigFieldControl({
  field,
  value,
  config,
  locked,
  revealed,
  className = '',
  onChange,
  onReveal,
}: {
  field: ConfigField
  value: string
  config?: Record<string, unknown>
  locked: boolean
  revealed: boolean
  className?: string
  onChange: (key: string, value: string) => void
  onReveal: (key: string) => void
}) {
  const inputId = `config-${field.key.toLowerCase().replace(/_/g, '-')}`
  const fieldClassName = [
    'config-field',
    field.span === 'full' ? 'field-span-full' : '',
    className,
  ].filter(Boolean).join(' ')
  const displayValue = value.trim()
  const metaLabel = locked ? '运行锁定' : displayValue ? '已设置' : '未设置'
  const hint = field.helper ?? (displayValue ? '当前配置值已加载。' : '未设置时使用系统默认值。')

  return (
    <div className={fieldClassName}>
      <div className="field-head">
        <label htmlFor={inputId}>{field.label}</label>
        <small className={locked ? 'locked' : displayValue ? 'set' : 'empty'}>{metaLabel}</small>
      </div>
      {field.input === 'select' ? (
        <select
          autoComplete="off"
          id={inputId}
          name={field.key}
          value={value}
          onChange={(event) => onChange(field.key, event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {field.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
      ) : field.sensitive ? (
        <div className="secret-input">
          <input
            autoComplete="off"
            id={inputId}
            inputMode={inputModeForField(field)}
            name={field.key}
            spellCheck={false}
            type={revealed ? 'text' : 'password'}
            step={field.input === 'number' ? numberStepForField(field) : undefined}
            value={value}
            placeholder={placeholderForField(field, config)}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
          <button
            type="button"
            aria-label={revealed ? `隐藏${field.label}` : `显示${field.label}`}
            className="icon-button"
            title={revealed ? '隐藏' : '显示'}
            onClick={() => onReveal(field.key)}
          >
            {revealed ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </div>
      ) : (
        <input
          autoComplete="off"
          id={inputId}
          inputMode={inputModeForField(field)}
          name={field.key}
          spellCheck={false}
          type={field.input}
          step={field.input === 'number' ? numberStepForField(field) : undefined}
          value={value}
          placeholder={placeholderForField(field, config)}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      )}
      <p className="field-hint">{hint}</p>
    </div>
  )
}

function KeyValueGrid({ data }: { data?: Record<string, unknown> }) {
  const entries = Object.entries(data ?? {})

  if (!entries.length) {
    return <div className="notice warn">暂无配置</div>
  }

  return (
    <dl className="kv-grid">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function buildConfigDraft(
  config: Record<string, unknown> | undefined,
  videoConfig: VideoConfig | undefined,
): ConfigDraft {
  const capture = videoConfig?.capture ?? pickObject(config, 'capture')
  const stream = { ...pickObject(config, 'stream'), ...(videoConfig?.stream ?? {}) }
  const inference = pickObject(config, 'inference')
  const analysis = pickObject(config, 'analysis')
  const database = pickObject(config, 'database')
  const spool = pickObject(config, 'spool')
  const remote = pickObject(config, 'remote')
  const observability = pickObject(config, 'observability')
  const security = pickObject(config, 'security')

  return {
    API_AUTH_TOKEN: stringValue(security.api_auth_token),
    CAPTURE_SOURCE_KIND: stringValue(capture.source_kind, 'http_mjpeg'),
    CAPTURE_SOURCE_URL: stringValue(capture.source_url),
    CAPTURE_USERNAME: stringValue(capture.username),
    CAPTURE_PASSWORD: stringValue(capture.password),
    CAPTURE_FPS_LIMIT: stringValue(capture.fps_limit, '15'),
    CAPTURE_ROTATE_DEGREES: stringValue(capture.rotate_degrees, '0'),
    CAPTURE_DEVICE_ID: stringValue(capture.device_id, '1'),
    CAPTURE_TASK_ID: stringValue(capture.task_id, '1'),
    STREAM_MODE: stringValue(stream.mode, 'pull'),
    STREAM_PROTOCOL: stringValue(stream.protocol, 'http_mjpeg'),
    STREAM_PUSH_URL: stringValue(stream.push_url),
    STREAM_RECEIVER_KIND: stringValue(stream.receiver_kind, 'none'),
    STREAM_RECEIVER_STATUS_URL: stringValue(stream.receiver_status_url),
    STREAM_USERNAME: stringValue(stream.username),
    STREAM_PASSWORD: stringValue(stream.password),
    INFERENCE_ENDPOINT: stringValue(inference.endpoint),
    INFERENCE_API_TOKEN: stringValue(inference.api_token),
    INFERENCE_DEVICE: stringValue(inference.device, 'auto'),
    INFERENCE_MODEL: stringValue(inference.model, 'yolov8n.pt'),
    CONFIDENCE_THRESHOLD: stringValue(inference.confidence_threshold, '0.5'),
    FRAME_INTERVAL: stringValue(inference.frame_interval, '10'),
    DETECTION_CLASS_FILTER: stringValue(inference.class_filter),
    ANALYSIS_TIME_RANGE_MINUTES: stringValue(analysis.time_range_minutes, '30'),
    DATABASE_URL: stringValue(database.url),
    DATABASE_CONNECT_TIMEOUT: stringValue(database.connect_timeout, '5'),
    DATABASE_BATCH_SIZE: stringValue(database.batch_size, '50'),
    DATABASE_FLUSH_INTERVAL_MS: stringValue(database.flush_interval_ms, '1000'),
    SPOOL_SQLITE_PATH: stringValue(spool.sqlite_path, 'runtime/spool.db'),
    REMOTE_API_BASE_URL: stringValue(remote.api_base_url),
    REMOTE_API_HOST: stringValue(remote.api_host, '0.0.0.0'),
    REMOTE_API_PORT: stringValue(remote.api_port, '8000'),
    REMOTE_SSH_HOST: stringValue(remote.ssh_host),
    REMOTE_SSH_PORT: stringValue(remote.ssh_port, '22'),
    REMOTE_SSH_USER: stringValue(remote.ssh_user),
    REMOTE_SSH_KEY_PATH: stringValue(remote.ssh_key_path),
    REMOTE_PIP_INDEX_URLS: stringValue(remote.pip_index_urls),
    REMOTE_PIP_TRUSTED_HOSTS: stringValue(remote.pip_trusted_hosts),
    REMOTE_PIP_PROXY: stringValue(remote.pip_proxy_url),
    GRAFANA_BASE_URL: stringValue(observability.grafana_base_url),
    GRAFANA_DASHBOARD_URL: stringValue(observability.grafana_dashboard_url),
  }
}

function collectConfigValues(
  draft: ConfigDraft,
  currentDraft: ConfigDraft,
): Record<string, ConfigValue> {
  const values: Record<string, ConfigValue> = {}

  for (const group of configGroups) {
    for (const field of group.fields) {
      const raw = draft[field.key] ?? ''

      if (raw === (currentDraft[field.key] ?? '')) {
        continue
      }

      if (field.input === 'number') {
        if (raw === '') {
          continue
        }
        values[field.key] = Number(raw)
      } else {
        values[field.key] = raw
      }
    }
  }

  return values
}

function collectProbeValues(draft: ConfigDraft): Record<string, ConfigValue> {
  const values: Record<string, ConfigValue> = {}

  for (const group of configGroups) {
    for (const field of group.fields) {
      const raw = draft[field.key] ?? ''

      if (field.input === 'number') {
        if (raw === '') {
          continue
        }
        values[field.key] = Number(raw)
      } else {
        values[field.key] = raw
      }
    }
  }

  return values
}

function getTabFromLocation(): TabKey {
  if (typeof window === 'undefined') {
    return 'overview'
  }

  const tab = new URLSearchParams(window.location.search).get('tab')
  return isTabKey(tab) ? tab : 'overview'
}

function isTabKey(value: string | null): value is TabKey {
  return value !== null && tabKeys.has(value as TabKey)
}

function isApiTokenRequiredError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('API token required')
}

function getFrameDisplayMode(): FrameDisplayMode {
  if (typeof window === 'undefined') {
    return 'adaptive'
  }

  const value = window.localStorage.getItem(FRAME_DISPLAY_MODE_STORAGE_KEY)
  return isFrameDisplayMode(value) ? value : 'adaptive'
}

function setFrameDisplayModePreference(value: FrameDisplayMode) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(FRAME_DISPLAY_MODE_STORAGE_KEY, value)
  }
}

function isFrameDisplayMode(value: string | null): value is FrameDisplayMode {
  return value === 'contain' || value === 'cover' || value === 'adaptive'
}

function nextFrameDisplayMode(current: FrameDisplayMode): FrameDisplayMode {
  if (current === 'adaptive') {
    return 'contain'
  }
  if (current === 'contain') {
    return 'cover'
  }
  return 'adaptive'
}

function frameDisplayModeLabel(mode: FrameDisplayMode): string {
  if (mode === 'adaptive') {
    return '自适应填满'
  }
  if (mode === 'cover') {
    return '铺满裁切'
  }
  return '完整比例'
}

function frameDisplayModeIcon(mode: FrameDisplayMode) {
  if (mode === 'adaptive') {
    return <Focus size={17} aria-hidden="true" />
  }
  if (mode === 'cover') {
    return <ScanLine size={17} aria-hidden="true" />
  }
  return <ArrowDownUp size={17} aria-hidden="true" />
}

function adaptiveFrameStageStyle(
  mode: FrameDisplayMode,
  frameWidth: number,
  frameHeight: number,
  expanded: boolean,
): CSSProperties | undefined {
  if (mode !== 'adaptive' || frameWidth <= 0 || frameHeight <= 0) {
    return undefined
  }

  const aspect = frameWidth / frameHeight
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return undefined
  }

  const targetHeight = expanded
    ? aspect < 1
      ? 760
      : 680
    : aspect < 1
      ? 720
      : 560
  const minWidth = expanded ? 520 : 480
  const maxWidth = expanded ? 980 : 1180
  const width = Math.round(clampNumber(aspect * targetHeight, minWidth, maxWidth))

  return {
    aspectRatio: `${frameWidth} / ${frameHeight}`,
    width: `min(100%, ${width}px)`,
  }
}

function writeTabToUrl(tab: TabKey, mode: 'push' | 'replace') {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('tab', tab)
  const nextPath = `${url.pathname}${url.search}${url.hash}`
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`

  if (nextPath === currentPath) {
    return
  }

  if (mode === 'replace') {
    window.history.replaceState(null, '', nextPath)
  } else {
    window.history.pushState(null, '', nextPath)
  }
}

function inputModeForField(field: ConfigField): ConfigInputMode | undefined {
  if (field.input === 'number') {
    return field.key === 'CONFIDENCE_THRESHOLD' ? 'decimal' : 'numeric'
  }
  if (field.input === 'url' || field.key === 'DATABASE_URL') {
    return 'url'
  }
  if (field.input === 'password') {
    return undefined
  }
  return 'text'
}

function numberStepForField(field: ConfigField): string {
  return field.key === 'CONFIDENCE_THRESHOLD' ? '0.05' : '1'
}

function placeholderForField(field: ConfigField, config?: Record<string, unknown>): string {
  void config
  return field.placeholder ?? ''
}

function formatSaveResult(result?: Record<string, unknown>): string {
  if (!result) {
    return ''
  }

  const updated = result.updated
  if (Array.isArray(updated) && updated.length) {
    return `已保存 ${numberFormatter.format(updated.length)} 项`
  }
  return '没有配置变更'
}

function formatProbeSummary(result?: EnvironmentResponse): string {
  if (!result) {
    return ''
  }

  return `预检 ${numberFormatter.format(result.summary.ok)} 正常 / ${numberFormatter.format(result.summary.warn)} 提醒 / ${numberFormatter.format(result.summary.error)} 错误`
}

function formatRemoteOutput(result?: Record<string, unknown>): string {
  if (!result) {
    return ''
  }

  const lines = [
    `${String(result.action ?? 'remote')} ${String(result.status ?? '')}`.trim(),
    result.message ? String(result.message) : '',
    result.stdout ? String(result.stdout).trim() : '',
    result.stderr ? String(result.stderr).trim() : '',
  ].filter(Boolean)

  return lines.join('\n\n')
}

function grafanaEntryHref(
  check: EnvironmentCheck | undefined,
  config: Record<string, unknown> | undefined,
): string {
  if (check?.status !== 'ok') {
    return ''
  }

  const observability = pickObject(config, 'observability')
  const dashboardUrl = stringValue(
    check.details.dashboard_url || observability.grafana_dashboard_url,
  ).trim()

  return toGrafanaProxyHref(dashboardUrl)
}

function toGrafanaProxyHref(value: string): string {
  const fallback = '/grafana/'
  const trimmed = value.trim()

  if (!trimmed || trimmed === '-') {
    return fallback
  }

  if (trimmed.startsWith('/grafana')) {
    return trimmed
  }

  if (trimmed.startsWith('/')) {
    return `/grafana${trimmed === '/' ? '/' : trimmed}`
  }

  try {
    const url = new URL(trimmed)
    const path = `${url.pathname}${url.search}${url.hash}`
    if (url.pathname.startsWith('/grafana')) {
      return path || fallback
    }
    return `/grafana${url.pathname === '/' ? '/' : path}`
  } catch {
    return fallback
  }
}

function stringValue(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) {
    return fallback
  }
  return String(value)
}

function pickObject(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = source?.[key]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no'
  }
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  if (typeof value === 'number') {
    return numberFormatter.format(value)
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function formatLogDetails(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2)
}

function logLevelLabel(level: LogLevel | string): string {
  const labels: Record<string, string> = {
    info: '信息',
    ok: '正常',
    warn: '警告',
    error: '错误',
  }
  return labels[level] ?? String(level)
}

function logSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    write: '写入流程',
    capture: '采集',
    spool: '缓存写库',
    analysis: '时序分析',
    system: '系统',
  }
  return labels[source] ?? source
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    blocked: '已阻止',
    error: '错误',
    ok: '正常',
    ready: '待执行',
    warn: '警告',
  }
  return labels[status] ?? status
}

function analysisStatusLabel(status: string): string {
  return statusLabel(status)
}

function statusClassName(status: string): 'info' | 'ok' | 'warn' | 'error' {
  if (status === 'ok') {
    return 'ok'
  }
  if (status === 'warn') {
    return 'warn'
  }
  if (status === 'error') {
    return 'error'
  }
  return 'info'
}

function cleanQueryTitle(title: string): string {
  return title.replace(/^\s*\d+[.、]\s*/, '')
}

function boundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.min(max, parsed))
}

function detectionBoxStyle(
  detection: DetectionSnapshot,
  frameWidth: number,
  frameHeight: number,
  stageSize: { width: number; height: number },
  displayMode: FrameDisplayMode,
): Record<string, string> | undefined {
  const x1 = numberOrNull(detection.bbox_x1)
  const y1 = numberOrNull(detection.bbox_y1)
  const x2 = numberOrNull(detection.bbox_x2)
  const y2 = numberOrNull(detection.bbox_y2)
  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    return undefined
  }

  const normalized = x2 <= 1 && y2 <= 1
  const coordinateWidthBase = normalized ? 1 : frameWidth
  const coordinateHeightBase = normalized ? 1 : frameHeight
  const imageWidthBase = frameWidth > 0 ? frameWidth : coordinateWidthBase
  const imageHeightBase = frameHeight > 0 ? frameHeight : coordinateHeightBase
  if (coordinateWidthBase <= 0 || coordinateHeightBase <= 0 || imageWidthBase <= 0 || imageHeightBase <= 0) {
    return undefined
  }
  if (stageSize.width <= 0 || stageSize.height <= 0) {
    return undefined
  }

  const left = clampNumber(Math.min(x1, x2) / coordinateWidthBase, 0, 1)
  const top = clampNumber(Math.min(y1, y2) / coordinateHeightBase, 0, 1)
  const right = clampNumber(Math.max(x1, x2) / coordinateWidthBase, 0, 1)
  const bottom = clampNumber(Math.max(y1, y2) / coordinateHeightBase, 0, 1)
  const width = right - left
  const height = bottom - top
  if (width <= 0.005 || height <= 0.005) {
    return undefined
  }

  const scale = frameImageFitMode(displayMode, imageWidthBase, imageHeightBase, stageSize) === 'cover'
    ? Math.max(stageSize.width / imageWidthBase, stageSize.height / imageHeightBase)
    : Math.min(stageSize.width / imageWidthBase, stageSize.height / imageHeightBase)
  const imageWidth = imageWidthBase * scale
  const imageHeight = imageHeightBase * scale
  const offsetX = (stageSize.width - imageWidth) / 2
  const offsetY = (stageSize.height - imageHeight) / 2

  return {
    left: `${offsetX + left * imageWidth}px`,
    top: `${offsetY + top * imageHeight}px`,
    width: `${width * imageWidth}px`,
    height: `${height * imageHeight}px`,
  }
}

function frameImageFitMode(
  displayMode: FrameDisplayMode,
  frameWidth: number,
  frameHeight: number,
  stageSize: { width: number; height: number },
): 'contain' | 'cover' {
  if (displayMode === 'adaptive') {
    return frameWidth > 0 && frameHeight > 0 && stageSize.width > 0 && stageSize.height > 0 ? 'cover' : 'contain'
  }
  return displayMode
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function formatDetectionLabel(detection: DetectionSnapshot): string {
  return `${detection.object_class} ${formatConfidence(detection.confidence)}`
}

function formatConfidence(value: number | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-'
  }
  return confidenceFormatter.format(value)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return dateTimeFormatter.format(date)
}

function formatBucketLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return timeFormatter.format(date)
}

function toneFromRuntime(status?: string): CheckStatus {
  if (status === 'running' || status === 'ok') {
    return 'ok'
  }
  if (status === 'error') {
    return 'error'
  }
  return 'warn'
}

export default App
