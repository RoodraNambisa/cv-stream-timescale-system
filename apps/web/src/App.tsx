import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDownUp,
  BarChart3,
  Cpu,
  Database,
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
  probeEnvironment,
  probeVideo,
  reloadConfig,
  runRemoteAction,
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
  sensitive?: boolean
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

const configGroups: ConfigGroup[] = [
  {
    eyebrow: 'Capture',
    title: '视频输入',
    icon: Video,
    accent: 'accent-video',
    fields: [
      { key: 'CAPTURE_SOURCE_KIND', label: '输入类型', input: 'select', options: ['http_mjpeg', 'rtsp', 'rtmp', 'camera', 'file'] },
      { key: 'CAPTURE_SOURCE_URL', label: '拉流地址', input: 'url', placeholder: 'http://手机IP:8080/video 或 rtsp://host/live…' },
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
      { key: 'STREAM_PUSH_URL', label: '推流地址', input: 'url', placeholder: 'rtmp://server/live/camera-1…' },
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
      { key: 'INFERENCE_ENDPOINT', label: '远端推理直连 URL', input: 'url', placeholder: 'http://服务器:8000…' },
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
      { key: 'DATABASE_URL', label: '数据库连接串', input: 'password', sensitive: true, placeholder: '留空保留当前连接串…' },
      { key: 'DATABASE_CONNECT_TIMEOUT', label: '连接超时秒数', input: 'number' },
      { key: 'DATABASE_BATCH_SIZE', label: '批量写入条数', input: 'number' },
      { key: 'DATABASE_FLUSH_INTERVAL_MS', label: '刷库间隔毫秒', input: 'number' },
      { key: 'SPOOL_SQLITE_PATH', label: 'SQLite spool 路径', input: 'text' },
    ],
  },
  {
    eyebrow: 'Remote',
    title: '远端管理',
    icon: Server,
    accent: 'accent-remote',
    fields: [
      { key: 'REMOTE_API_BASE_URL', label: '直连 API Base URL', input: 'url', placeholder: 'http://服务器:8000…' },
      { key: 'REMOTE_API_HOST', label: '服务器 API 监听主机', input: 'text' },
      { key: 'REMOTE_API_PORT', label: '服务器 API 监听端口', input: 'number' },
      { key: 'REMOTE_SSH_HOST', label: 'SSH 管理主机', input: 'text', placeholder: '可选…' },
      { key: 'REMOTE_SSH_PORT', label: 'SSH 管理端口', input: 'number' },
      { key: 'REMOTE_SSH_USER', label: 'SSH 管理用户', input: 'text', placeholder: '可选…' },
      { key: 'REMOTE_SSH_KEY_PATH', label: 'SSH 私钥路径', input: 'text', placeholder: '可选…' },
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
  { action: 'api_start', label: 'SSH 启动 API', icon: Play },
  { action: 'api_status', label: 'SSH API 状态', icon: Activity },
  { action: 'api_stop', label: 'SSH 停止 API', icon: Square },
  { action: 'api_logs', label: 'SSH API 日志', icon: Terminal },
]

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>(() => getTabFromLocation())
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
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  })

  const environment = useQuery({
    queryKey: ['environment'],
    queryFn: fetchEnvironment,
    refetchInterval: 10_000,
  })

  const spool = useQuery({
    queryKey: ['spool'],
    queryFn: fetchSpoolStatus,
    refetchInterval: 10_000,
  })

  const video = useQuery({
    queryKey: ['video-config'],
    queryFn: fetchVideoConfig,
    refetchInterval: 20_000,
  })

  const inference = useQuery({
    queryKey: ['inference-status'],
    queryFn: fetchInferenceStatus,
    refetchInterval: 10_000,
  })

  const capture = useQuery({
    queryKey: ['capture-status'],
    queryFn: fetchCaptureStatus,
    refetchInterval: 3_000,
  })

  const analysis = useQuery({
    queryKey: ['analysis-summary'],
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
          <span className={`pill ${apiStatus === 'ok' ? 'ok' : 'warn'}`}>
            <Server size={16} aria-hidden="true" />
            API {apiStatus}
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

  return (
    <article className={`signal-card ${tone}`}>
      <div className="signal-icon">
        <Icon size={18} aria-hidden="true" />
      </div>
      <div>
        <p>{label}</p>
        <strong>{check?.message ?? fallback}</strong>
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
  const visibleDraft = dirty ? draft : currentDraft

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

  const saveMessage = saveError ?? formatSaveResult(saveResult)
  const remoteOutput = remoteError ?? formatRemoteOutput(remoteResult)
  const configProbeMessage = configProbeError ?? formatProbeSummary(configProbeResult)
  const configProbeChecks = configProbeResult?.checks ?? []
  const remoteConfig = pickObject(config, 'remote')
  const sshConfigured = Boolean(remoteConfig.ssh_configured)

  return (
    <section className="config-layout config-editable">
      {configGroups.map((group) => {
        const Icon = group.icon
        return (
          <div className={`panel config-card ${group.accent}`} key={group.title}>
            <PanelHeading eyebrow={group.eyebrow} title={group.title} icon={Icon} />
            <div className="field-grid">
              {group.fields.map((field) => (
                <label className="config-field" key={field.key}>
                  <span className="field-head">
                    <span>{field.label}</span>
                    {lockedConfigKeys.has(field.key) && <small>运行锁定</small>}
                  </span>
                  {field.input === 'select' ? (
                    <select
                      autoComplete="off"
                      name={field.key}
                      value={visibleDraft[field.key] ?? ''}
                      onChange={(event) => updateField(field.key, event.target.value)}
                    >
                      {(field.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      autoComplete="off"
                      inputMode={inputModeForField(field)}
                      name={field.key}
                      spellCheck={false}
                      type={field.input}
                      step={field.input === 'number' ? numberStepForField(field) : undefined}
                      value={visibleDraft[field.key] ?? ''}
                      placeholder={placeholderForField(field, config)}
                      onChange={(event) => updateField(field.key, event.target.value)}
                    />
                  )}
                </label>
              ))}
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
        <PanelHeading eyebrow="Remote Ops" title="SSH 远端管理" icon={Server} />
        <div className={`notice ${sshConfigured ? 'ok' : 'warn'}`}>
          {sshConfigured
            ? 'SSH 已配置，仅用于远端检测、同步、安装、配库和启停 API。'
            : 'SSH 未配置；数据库和推理 API 仍可通过直连 URL 使用。'}
        </div>
        <div className="remote-password-row">
          <label className="config-field">
            <span className="field-head">
              <span>SSH 配库密码</span>
            </span>
            <input
              autoComplete="off"
              inputMode="text"
              name="REMOTE_DATABASE_PASSWORD"
              spellCheck={false}
              type="password"
              value={remoteDbPassword}
              placeholder="留空自动生成或使用脚本默认值…"
              onChange={(event) => setRemoteDbPassword(event.target.value)}
            />
          </label>
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

  return {
    CAPTURE_SOURCE_KIND: stringValue(capture.source_kind, 'http_mjpeg'),
    CAPTURE_SOURCE_URL: stringValue(capture.source_url),
    CAPTURE_USERNAME: '',
    CAPTURE_PASSWORD: '',
    CAPTURE_FPS_LIMIT: stringValue(capture.fps_limit, '15'),
    CAPTURE_DEVICE_ID: stringValue(capture.device_id, '1'),
    CAPTURE_TASK_ID: stringValue(capture.task_id, '1'),
    STREAM_MODE: stringValue(stream.mode, 'pull'),
    STREAM_PROTOCOL: stringValue(stream.protocol, 'http_mjpeg'),
    STREAM_PUSH_URL: stringValue(stream.push_url),
    STREAM_RECEIVER_KIND: stringValue(stream.receiver_kind, 'none'),
    STREAM_RECEIVER_STATUS_URL: stringValue(stream.receiver_status_url),
    STREAM_USERNAME: '',
    STREAM_PASSWORD: '',
    INFERENCE_ENDPOINT: stringValue(inference.endpoint),
    INFERENCE_DEVICE: stringValue(inference.device, 'auto'),
    INFERENCE_MODEL: stringValue(inference.model, 'yolov8n.pt'),
    CONFIDENCE_THRESHOLD: stringValue(inference.confidence_threshold, '0.5'),
    FRAME_INTERVAL: stringValue(inference.frame_interval, '10'),
    DETECTION_CLASS_FILTER: stringValue(inference.class_filter),
    ANALYSIS_TIME_RANGE_MINUTES: stringValue(analysis.time_range_minutes, '30'),
    DATABASE_URL: '',
    DATABASE_CONNECT_TIMEOUT: stringValue(database.connect_timeout, '5'),
    DATABASE_BATCH_SIZE: stringValue(database.batch_size, '50'),
    DATABASE_FLUSH_INTERVAL_MS: stringValue(database.flush_interval_ms, '1000'),
    SPOOL_SQLITE_PATH: stringValue(spool.sqlite_path, 'runtime/spool.db'),
    REMOTE_API_BASE_URL: stringValue(remote.api_base_url),
    REMOTE_API_HOST: stringValue(remote.api_host, '127.0.0.1'),
    REMOTE_API_PORT: stringValue(remote.api_port, '8000'),
    REMOTE_SSH_HOST: stringValue(remote.ssh_host),
    REMOTE_SSH_PORT: stringValue(remote.ssh_port, '22'),
    REMOTE_SSH_USER: stringValue(remote.ssh_user),
    REMOTE_SSH_KEY_PATH: stringValue(remote.ssh_key_path),
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

      if (field.sensitive && raw === '') {
        continue
      }

      if (!field.sensitive && raw === (currentDraft[field.key] ?? '')) {
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

      if (field.sensitive && raw === '') {
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
  if (field.key === 'DATABASE_URL') {
    const currentUrl = pickObject(config, 'database').url
    return currentUrl ? String(currentUrl) : field.placeholder ?? ''
  }

  if (field.key === 'CAPTURE_PASSWORD') {
    return pickObject(config, 'capture').password_set ? '已设置，留空保留…' : '未设置…'
  }

  if (field.key === 'STREAM_PASSWORD') {
    return pickObject(config, 'stream').password_set ? '已设置，留空保留…' : '未设置…'
  }

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
