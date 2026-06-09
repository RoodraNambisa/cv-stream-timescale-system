import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDownUp,
  BarChart3,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Gauge,
  HardDrive,
  Layers3,
  ListChecks,
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
  Video,
  Wrench,
  Zap,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  type AnalysisSummary,
  type ActionResponse,
  type CaptureStatus,
  type CheckStatus,
  type ConfigValue,
  type DetectionSnapshot,
  type EnvironmentCheck,
  type EnvironmentResponse,
  type InferenceStatus,
  type RemoteAction,
  type SpoolStatus,
  type VideoConfig,
  fetchCaptureStatus,
  fetchAnalysisSummary,
  fetchEnvironment,
  fetchHealth,
  fetchInferenceStatus,
  fetchSpoolStatus,
  fetchVideoConfig,
  flushSpool,
  getApiAuthToken,
  getApiBaseUrl,
  probeEnvironment,
  probeApiBaseUrl,
  probeVideo,
  reloadConfig,
  runRemoteAction,
  setApiAuthToken,
  setApiBaseUrl,
  startCapture,
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

type TabKey = 'overview' | 'config' | 'tasks' | 'analysis'

const tabs: Array<{ key: TabKey; label: string; icon: typeof Activity }> = [
  { key: 'overview', label: '总览', icon: Activity },
  { key: 'config', label: '配置', icon: Settings },
  { key: 'tasks', label: '任务', icon: ListChecks },
  { key: 'analysis', label: '分析', icon: BarChart3 },
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

type ConfigField = {
  key: string
  label: string
  input: 'text' | 'number' | 'password' | 'select' | 'url'
  options?: string[]
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
    {
      key: 'CORS_ALLOWED_ORIGINS',
      label: '允许访问的前端 Origin',
      input: 'text',
      placeholder: 'http://127.0.0.1:5173 http://localhost:5173…',
      helper: '多个 Origin 用空格分隔；同源部署通常不用额外调整。',
    },
  ],
}

const workflowConfigGroups: ConfigGroup[] = [
  {
    eyebrow: 'Capture',
    title: '视频输入',
    icon: Video,
    accent: 'accent-video',
    fields: [
      { key: 'CAPTURE_SOURCE_KIND', label: '输入类型', input: 'select', options: ['http_mjpeg', 'rtsp', 'rtmp', 'camera', 'file'] },
      {
        key: 'CAPTURE_SOURCE_URL',
        label: '拉流地址',
        input: 'url',
        placeholder: 'http://手机IP:8080/video 或 rtsp://host/live…',
        helper: '支持 Android IP Webcam、RTSP、RTMP、文件和本机摄像头。',
        span: 'full',
      },
      { key: 'CAPTURE_USERNAME', label: '拉流账号', input: 'text' },
      { key: 'CAPTURE_PASSWORD', label: '拉流密码', input: 'password', sensitive: true },
      { key: 'CAPTURE_FPS_LIMIT', label: '采集 FPS 上限', input: 'number' },
      { key: 'CAPTURE_DEVICE_ID', label: '设备 ID', input: 'number' },
      { key: 'CAPTURE_TASK_ID', label: '任务 ID', input: 'number' },
    ],
  },
  {
    eyebrow: 'Stream',
    title: '推流接收',
    icon: RadioTower,
    accent: 'accent-stream',
    fields: [
      { key: 'STREAM_MODE', label: '流模式', input: 'select', options: ['pull', 'push'] },
      { key: 'STREAM_PROTOCOL', label: '推流协议', input: 'select', options: ['http_mjpeg', 'rtsp', 'rtmp'] },
      {
        key: 'STREAM_PUSH_URL',
        label: '推流地址',
        input: 'url',
        placeholder: 'rtmp://server/live/camera-1…',
        helper: '只在流模式选择 push 时使用。',
        span: 'full',
      },
      { key: 'STREAM_RECEIVER_KIND', label: '接收器类型', input: 'select', options: ['none', 'mediamtx', 'nginx_rtmp', 'custom'] },
      { key: 'STREAM_RECEIVER_STATUS_URL', label: '接收器状态 URL', input: 'url', placeholder: 'http://server:9997/v3/config/global/get…' },
      { key: 'STREAM_USERNAME', label: '推流账号', input: 'text' },
      { key: 'STREAM_PASSWORD', label: '推流密码', input: 'password', sensitive: true },
    ],
  },
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

const configGroups = [accessConfigGroup, ...workflowConfigGroups]

const tabKeys = new Set<TabKey>(tabs.map((tab) => tab.key))
const confidenceFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
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
  const [frontendApiBase, setFrontendApiBase] = useState(() => getApiBaseUrl())
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
    refetchInterval: 3_000,
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

  function handleTabChange(tab: TabKey) {
    setActiveTab(tab)
    writeTabToUrl(tab, 'push')
  }

  function handleFrontendApiBaseChange(value: string): string {
    const normalized = setApiBaseUrl(value)
    setFrontendApiBase(normalized)
    void queryClient.invalidateQueries()
    return normalized
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
          inferenceStatus={inference.data}
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
          frontendApiBase={frontendApiBase}
          frontendApiToken={frontendApiToken}
          onFrontendApiBaseChange={handleFrontendApiBaseChange}
          onFrontendApiTokenChange={handleFrontendApiTokenChange}
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
      </main>
    </>
  )
}

function FrameConsole({
  captureStatus,
  config,
  videoConfig,
  inferenceStatus,
}: {
  captureStatus?: CaptureStatus
  config?: Record<string, unknown>
  videoConfig?: VideoConfig
  inferenceStatus?: InferenceStatus
}) {
  const captureConfig = videoConfig?.capture ?? pickObject(config, 'capture')
  const source = String(captureConfig.source_url || captureStatus?.settings_locked?.source || '未配置视频源')
  const frameNumber = String(captureStatus?.frames_read ?? 0).padStart(6, '0')
  const model = String(pickObject(config, 'inference').model || 'yolov8n.pt')
  const tone = toneFromRuntime(captureStatus?.status)
  const recentDetections = captureStatus?.recent_detections ?? []
  const primaryDetection = recentDetections[0]
  const secondaryDetection = recentDetections[1]

  return (
    <section className="frame-console panel">
      <div className="frame-toolbar">
        <div>
          <p className="eyebrow">Frame Input</p>
          <h2>{source}</h2>
        </div>
        <span className={`live-chip ${tone}`}>
          <Activity size={15} aria-hidden="true" />
          {captureStatus?.status ?? 'idle'}
        </span>
      </div>

      <div className="video-stage" aria-label="视频帧预览">
        <div className="scan-grid" aria-hidden="true" />
        <div className="frame-meta top-left">
          <span>FRAME</span>
          <strong>{frameNumber}</strong>
        </div>
        <div className="frame-meta top-right">
          <span>MODEL</span>
          <strong>{model}</strong>
        </div>
        {primaryDetection ? (
          <div className="bbox bbox-primary">
            <span>{formatDetectionLabel(primaryDetection)}</span>
          </div>
        ) : (
          <div className="stage-empty">等待检测结果…</div>
        )}
        {secondaryDetection && (
          <div className="bbox bbox-secondary">
            <span>{formatDetectionLabel(secondaryDetection)}</span>
          </div>
        )}
        <div className="frame-footer">
          <span>{inferenceStatus?.message ?? '推理状态检测中…'}</span>
          <span>{captureStatus?.detections_queued ?? 0} queued</span>
        </div>
      </div>
    </section>
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
  frontendApiBase,
  frontendApiToken,
  onFrontendApiBaseChange,
  onFrontendApiTokenChange,
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
  frontendApiBase: string
  frontendApiToken: string
  onFrontendApiBaseChange: (value: string) => string
  onFrontendApiTokenChange: (value: string) => string
  onRemoteAction: (action: RemoteAction, payload?: { remote_db_password?: string }) => void
  remotePending: boolean
  remoteResult?: Record<string, unknown>
  remoteError?: string
}) {
  const currentDraft = useMemo(() => buildConfigDraft(config, videoConfig), [config, videoConfig])
  const [draft, setDraft] = useState<ConfigDraft>({})
  const [dirty, setDirty] = useState(false)
  const [remoteDbPassword, setRemoteDbPassword] = useState('')
  const [apiBaseDraftState, setApiBaseDraftState] = useState(() => ({
    source: frontendApiBase,
    value: frontendApiBase,
  }))
  const [apiTokenDraftState, setApiTokenDraftState] = useState(() => ({
    source: frontendApiToken,
    value: frontendApiToken,
  }))
  const [apiTokenVisible, setApiTokenVisible] = useState(false)
  const [revealedFields, setRevealedFields] = useState<Set<string>>(() => new Set())
  const [apiBasePending, setApiBasePending] = useState(false)
  const [apiBaseMessage, setApiBaseMessage] = useState('')
  const visibleDraft = dirty ? draft : currentDraft
  const apiBaseDraft = apiBaseDraftState.source === frontendApiBase ? apiBaseDraftState.value : frontendApiBase
  const apiTokenDraft = apiTokenDraftState.source === frontendApiToken ? apiTokenDraftState.value : frontendApiToken
  const configuredRemoteApiBase = visibleDraft.REMOTE_API_BASE_URL ?? ''
  const serverTokenConfigured = Boolean((visibleDraft.API_AUTH_TOKEN ?? '').trim())
  const browserTokenConfigured = Boolean(frontendApiToken.trim())
  const browserApiMode = frontendApiBase ? '直连 API' : '同源 /api'
  const accessTone = serverTokenConfigured
    ? browserTokenConfigured
      ? 'ok'
      : 'warn'
    : 'ok'
  const accessMessage = serverTokenConfigured
    ? browserTokenConfigured
      ? '服务端已启用鉴权，当前浏览器会自动携带 Bearer token。'
      : '服务端已启用鉴权；需要在当前浏览器保存同一个 token 才能访问受保护接口。'
    : '服务端未启用接口鉴权；当前浏览器不需要保存 token。'

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
    setDraft((current) => ({ ...(dirty ? current : currentDraft), [key]: value }))
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

  function saveFrontendApiBase(value = apiBaseDraft) {
    try {
      const normalized = onFrontendApiBaseChange(value)
      setApiBaseDraftState({ source: normalized, value: normalized })
      setApiBaseMessage(normalized ? `前端请求已切到 ${normalized}` : '前端已恢复同源 /api')
    } catch (error) {
      setApiBaseMessage(error instanceof Error ? error.message : 'API 地址无效')
    }
  }

  function saveFrontendApiToken() {
    const token = onFrontendApiTokenChange(apiTokenDraft)
    setApiTokenDraftState({ source: token, value: token })
    setApiBaseMessage(token ? '浏览器令牌已保存' : '浏览器令牌已清除')
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

  async function testFrontendApiBase() {
    setApiBasePending(true)
    try {
      const result = await probeApiBaseUrl(apiBaseDraft)
      setApiBaseMessage(`${result.service} ${result.status}`)
    } catch (error) {
      setApiBaseMessage(error instanceof Error ? error.message : 'API 检测失败')
    } finally {
      setApiBasePending(false)
    }
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

  return (
    <section className="config-layout config-editable">
      <div className="panel access-panel full-config">
        <PanelHeading eyebrow={accessConfigGroup.eyebrow} title={accessConfigGroup.title} icon={ShieldCheck} />

        <div className="access-rail" aria-label="浏览器到后端接口的连接状态">
          <div className="rail-node">
            <span>Browser</span>
            <strong>{browserApiMode}</strong>
          </div>
          <i aria-hidden="true" />
          <div className="rail-node">
            <span>Auth</span>
            <strong>{serverTokenConfigured ? '服务端要求 Bearer' : '未启用'}</strong>
          </div>
          <i aria-hidden="true" />
          <div className="rail-node">
            <span>API</span>
            <strong>{frontendApiBase || '当前域名 /api'}</strong>
          </div>
        </div>

        <div className={`notice ${accessTone}`}>{accessMessage}</div>

        <div className="access-grid">
          <section className="access-column">
            <div className="access-column-head">
              <div>
                <p className="eyebrow">Server Rule</p>
                <h3>服务端接口保护</h3>
              </div>
              <span className={`mini-status ${serverTokenConfigured ? 'ok' : 'warn'}`}>
                {serverTokenConfigured ? '已启用' : '未启用'}
              </span>
            </div>
            <div className="field-grid access-fields">
              {accessConfigGroup.fields.map((field) => renderConfigField(field))}
            </div>
          </section>

          <section className="access-column">
            <div className="access-column-head">
              <div>
                <p className="eyebrow">Current Browser</p>
                <h3>当前浏览器请求凭证</h3>
              </div>
              <span className={`mini-status ${browserTokenConfigured ? 'ok' : serverTokenConfigured ? 'warn' : 'ok'}`}>
                {browserTokenConfigured ? '已保存' : serverTokenConfigured ? '待填写' : '不需要'}
              </span>
            </div>
            <div className="field-grid access-fields">
              <div className="config-field field-span-full">
                <div className="field-head">
                  <label htmlFor="frontend-api-base-url">浏览器 API Base URL</label>
                  <small>{frontendApiBase ? '自定义' : '默认'}</small>
                </div>
                <input
                  autoComplete="off"
                  id="frontend-api-base-url"
                  inputMode="url"
                  name="FRONTEND_API_BASE_URL"
                  spellCheck={false}
                  type="url"
                  value={apiBaseDraft}
                  placeholder="留空使用当前域名 /api，或填写 http://API_HOST:8000…"
                  onChange={(event) => setApiBaseDraftState({ source: frontendApiBase, value: event.target.value })}
                />
                <p className="field-hint">
                  只保存在当前浏览器；本服务单端口部署时保持空即可。
                </p>
              </div>

              <div className="config-field field-span-full">
                <div className="field-head">
                  <label htmlFor="frontend-api-auth-token">当前浏览器 Bearer token</label>
                  <small>{frontendApiToken ? '已保存' : '未保存'}</small>
                </div>
                <div className="secret-input">
                  <input
                    autoComplete="off"
                    id="frontend-api-auth-token"
                    inputMode="text"
                    name="FRONTEND_API_AUTH_TOKEN"
                    spellCheck={false}
                    type={apiTokenVisible ? 'text' : 'password'}
                    value={apiTokenDraft}
                    placeholder="填写服务端 API_AUTH_TOKEN 后保存到浏览器…"
                    onChange={(event) => setApiTokenDraftState({ source: frontendApiToken, value: event.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={apiTokenVisible ? '隐藏当前浏览器 token' : '显示当前浏览器 token'}
                    className="icon-button"
                    title={apiTokenVisible ? '隐藏' : '显示'}
                    onClick={() => setApiTokenVisible((current) => !current)}
                  >
                    {apiTokenVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                  </button>
                </div>
                <p className="field-hint">
                  这个值不会写入服务端配置，只会随当前浏览器的 API 请求发送。
                </p>
              </div>
            </div>
            <div className="action-row api-base-actions">
              <button type="button" onClick={testFrontendApiBase} disabled={apiBasePending}>
                <ShieldCheck size={17} aria-hidden="true" />
                检测 API
              </button>
              <button type="button" onClick={() => saveFrontendApiBase()}>
                <Save size={17} aria-hidden="true" />
                保存浏览器连接
              </button>
              <button type="button" onClick={saveFrontendApiToken} disabled={!apiTokenDraft}>
                <ShieldCheck size={17} aria-hidden="true" />
                保存浏览器令牌
              </button>
              <button
                type="button"
                onClick={() => {
                  setApiTokenDraftState({ source: '', value: '' })
                  onFrontendApiTokenChange('')
                  setApiBaseMessage('浏览器令牌已清除')
                }}
                disabled={!frontendApiToken && !apiTokenDraft}
              >
                <RotateCw size={17} aria-hidden="true" />
                清除令牌
              </button>
              <button
                type="button"
                onClick={() => saveFrontendApiBase(configuredRemoteApiBase)}
                disabled={!configuredRemoteApiBase}
              >
                <Server size={17} aria-hidden="true" />
                使用配置中的 API
              </button>
              <button type="button" onClick={() => saveFrontendApiBase('')} disabled={!frontendApiBase && !apiBaseDraft}>
                <RotateCw size={17} aria-hidden="true" />
                恢复同源
              </button>
              {apiBaseMessage && <span className="action-result" aria-live="polite">{apiBaseMessage}</span>}
            </div>
          </section>
        </div>
      </div>

      {workflowConfigGroups.map((group) => {
        const Icon = group.icon
        return (
          <div className={`panel config-card ${group.accent}`} key={group.title}>
            <PanelHeading eyebrow={group.eyebrow} title={group.title} icon={Icon} />
            <div className="field-grid">
              {group.fields.map((field) => renderConfigField(field))}
            </div>
            {group.title === '视频输入' && (
              <div className="action-row">
                <button type="button" onClick={onProbe} disabled={probePending}>
                  <Play size={17} aria-hidden="true" />
                  检测视频配置
                </button>
                {probeResult && (
                  <span className="action-result" aria-live="polite">{String(probeResult.message ?? probeResult.status)}</span>
                )}
              </div>
            )}
            {group.title === '推流接收' && (
              <div className="tag-row">
                {(videoConfig?.supported_push_protocols ?? ['rtsp', 'rtmp']).map((item) => (
                  <span className="tag" key={item}>{item}</span>
                ))}
              </div>
            )}
            {group.title === '推理配置' && (
              <div className={`notice ${inferenceStatus?.status ?? 'warn'}`}>
                {inferenceStatus?.message ?? '推理状态检测中…'}
              </div>
            )}
          </div>
        )
      })}

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
    </section>
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
              {option}
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
  const stream = videoConfig?.stream ?? pickObject(config, 'stream')
  const inference = pickObject(config, 'inference')
  const analysis = pickObject(config, 'analysis')
  const database = pickObject(config, 'database')
  const spool = pickObject(config, 'spool')
  const remote = pickObject(config, 'remote')
  const observability = pickObject(config, 'observability')
  const security = pickObject(config, 'security')

  return {
    API_AUTH_TOKEN: stringValue(security.api_auth_token),
    CORS_ALLOWED_ORIGINS: stringValue(
      security.cors_allowed_origins,
      'http://127.0.0.1:5173 http://localhost:5173',
    ),
    CAPTURE_SOURCE_KIND: stringValue(capture.source_kind, 'http_mjpeg'),
    CAPTURE_SOURCE_URL: stringValue(capture.source_url),
    CAPTURE_USERNAME: stringValue(capture.username),
    CAPTURE_PASSWORD: stringValue(capture.password),
    CAPTURE_FPS_LIMIT: stringValue(capture.fps_limit, '15'),
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
