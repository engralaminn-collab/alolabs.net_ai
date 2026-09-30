'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Bot, Activity, AlertTriangle, CheckCircle2, XCircle, Clock, Zap, Shield, BarChart3, RefreshCw, ArrowRight, Plus, Play, Pause, RotateCcw, Eye, MessageSquare, TrendingUp, Heart } from 'lucide-react'

const PIPELINE_STEPS = ['Request', 'Validation', 'Planning', 'Tool Selection', 'Execution', 'Review', 'Logging', 'Delivery']
const CATEGORIES = ['Business', 'CRM', 'Marketing', 'Support', 'Research', 'Productivity', 'Technical']

interface CatalogItem { id: string; name: string; category: string; description: string; icon: string; color: string; installCount: number; avgRating: number; capabilities: string; version: string }
interface Instance { id: string; agentId: string; status: string; healthStatus: string; lastHealthCheck: string | null; testPassed: boolean; auditVerified: boolean; catalog?: CatalogItem; _count?: { executions: number; healthChecks: number } }
interface Execution { id: string; step: string; stepNumber: number; status: string; priority: string; requestId: string; riskScore: number; tokensUsed: number; costUsd: number; durationMs: number | null; createdAt: string; completedAt: string | null }
interface Alert { id: string; alertType: string; severity: string; message: string; isAcknowledged: boolean; createdAt: string }
interface SecurityStat { total: number; blocked: number; flagged: number; passed: number; blockRate: string }

export default function AiWorkforcePanel() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [executions, setExecutions] = useState<Execution[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [secStats, setSecStats] = useState<SecurityStat | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
 setLoading(true)
    try {
      const [c, i, e, a, s] = await Promise.all([
        fetch('/api/ai-workforce/catalog').then(r => r.json()).then(r => r.data || []),
        fetch('/api/ai-workforce/instances').then(r => r.json()).then(r => r.data || []),
        fetch('/api/ai-workforce/execute').then(r => r.json()).then(r => r.data || []),
        fetch('/api/ai-workforce/alerts').then(r => r.json()).then(r => r.data || []),
        fetch('/api/ai-security/stats').then(r => r.json()).then(r => r.data || null),
      ])
      setCatalog(c); setInstances(i); setExecutions(e); setAlerts(a); setSecStats(s)
    } catch {} finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const statusColor = (s: string) => s === 'active' || s === 'completed' ? 'bg-emerald-100 text-emerald-700' : s === 'error' || s === 'failed' ? 'bg-red-100 text-red-700' : s === 'paused' || s === 'disabled' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
  const healthColor = (h: string) => h === 'healthy' ? 'text-emerald-600' : h === 'degraded' ? 'text-amber-600' : h === 'down' ? 'text-red-600' : 'text-slate-400'
  const stepProgress = (step: string, stepNum: number) => ((PIPELINE_STEPS.indexOf(step) + 1) / PIPELINE_STEPS.length) * 100

  const activeInstances = instances.filter(i => i.status === 'active').length
  const totalExecutions = executions.length
  const completedExecs = executions.filter(e => e.status === 'completed').length
  const pendingAlerts = alerts.filter(a => !a.isAcknowledged).length

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B]">AI Workforce</h1>
          <p className="text-sm text-[#64748B]">Manage agents, executions, and marketplace services</p>
        </div>
        <Button onClick={fetchData} variant="outline" size="sm" className="gap-2"><RefreshCw className="w-4 h-4" /> Refresh</Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {[
          { label: 'Catalog Items', value: catalog.length, icon: Bot, color: 'text-[#003ABC]' },
          { label: 'Active Agents', value: activeInstances, icon: Activity, color: 'text-emerald-600' },
          { label: 'Total Executions', value: totalExecutions, icon: Zap, color: 'text-amber-600' },
          { label: 'Success Rate', value: totalExecutions > 0 ? `${Math.round(completedExecs / totalExecutions * 100)}%` : '—', icon: TrendingUp, color: 'text-emerald-600' },
          { label: 'Security Events', value: secStats?.total || 0, icon: Shield, color: 'text-red-600' },
          { label: 'Pending Alerts', value: pendingAlerts, icon: AlertTriangle, color: pendingAlerts > 0 ? 'text-red-600' : 'text-slate-400' },
        ].map((s, i) => (
          <Card key={i} className="border-[#E2E8F0]"><CardContent className="p-4 flex items-center gap-3">
            <s.icon className={`w-8 h-8 ${s.color} opacity-80`} />
            <div><p className="text-xs text-[#94A3B8]">{s.label}</p><p className="text-xl font-bold text-[#1E293B]">{s.value}</p></div>
          </CardContent></Card>
        ))}
      </div>

      {/* Main Content */}
      <Tabs defaultValue="catalog">
        <TabsList className="bg-[#F1F5F9]"><TabsTrigger value="catalog">Agent Catalog</TabsTrigger><TabsTrigger value="instances">Instances</TabsTrigger><TabsTrigger value="executions">Executions</TabsTrigger><TabsTrigger value="security">Security</TabsTrigger><TabsTrigger value="alerts">Alerts</TabsTrigger></TabsList>

        {/* Agent Catalog Tab */}
        <TabsContent value="catalog">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {catalog.map((item) => (
              <Card key={item.id} className="border-[#E2E8F0] hover:border-[#003ABC]/30 hover:shadow-md transition-all cursor-pointer">
                <CardHeader className="pb-2"><div className="flex items-start justify-between"><div className="flex items-center gap-3"><div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: item.color + '15' }}><Bot className="w-5 h-5" style={{ color: item.color }} /></div><div><CardTitle className="text-sm font-semibold text-[#1E293B]">{item.name}</CardTitle><p className="text-xs text-[#94A3B8]">{item.category}</p></div></div><Badge variant="outline" className="text-xs">v{item.version}</Badge></div></CardHeader>
                <CardContent className="pt-0"><p className="text-xs text-[#64748B] line-clamp-2 mb-3">{item.description}</p><div className="flex items-center justify-between text-xs text-[#94A3B8]"><span className="flex items-center gap-1"><Heart className="w-3 h-3" />{item.avgRating > 0 ? item.avgRating.toFixed(1) : 'New'}</span><span>{item.installCount} installs</span></div></CardContent>
              </Card>
            ))}
            {catalog.length === 0 && !loading && <Card className="col-span-full"><CardContent className="py-12 text-center text-[#94A3B8]">No catalog items yet. Add agents to the marketplace.</CardContent></Card>}
          </div>
        </TabsContent>

        {/* Instances Tab */}
        <TabsContent value="instances">
          <Card className="border-[#E2E8F0]"><CardContent className="p-0">
            <div className="max-h-[500px] overflow-y-auto">
              <table className="w-full text-sm"><thead className="bg-[#F8FAFC] sticky top-0"><tr><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Agent</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Status</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Health</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Executions</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Tested</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Audit</th></tr></thead>
              <tbody>{instances.map((inst) => (
                <tr key={inst.id} className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC] transition-colors">
                  <td className="px-4 py-3"><div className="flex items-center gap-2"><Bot className="w-4 h-4 text-[#003ABC]" /><span className="font-medium text-[#1E293B]">{inst.agentId}</span></div></td>
                  <td className="px-4 py-3"><Badge className={statusColor(inst.status)}>{inst.status}</Badge></td>
                  <td className="px-4 py-3"><span className={`font-medium ${healthColor(inst.healthStatus)}`}>{inst.healthStatus}</span></td>
                  <td className="px-4 py-3 text-[#64748B]">{inst._count?.executions || 0}</td>
                  <td className="px-4 py-3">{inst.testPassed ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-slate-300" />}</td>
                  <td className="px-4 py-3">{inst.auditVerified ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-slate-300" />}</td>
                </tr>
              ))}</tbody></table>
            </div>
          </CardContent></Card>
        </TabsContent>

        {/* Executions Tab */}
        <TabsContent value="executions">
          <Card className="border-[#E2E8F0]"><CardContent className="p-0">
            <div className="max-h-[500px] overflow-y-auto">
              <table className="w-full text-sm"><thead className="bg-[#F8FAFC] sticky top-0"><tr><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Request ID</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Step</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Progress</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Status</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Risk</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">Duration</th><th className="text-left px-4 py-3 text-xs font-semibold text-[#64748B]">When</th></tr></thead>
              <tbody>{executions.slice(0, 50).map((exec) => (
                <tr key={exec.id} className="border-t border-[#F1F5F9] hover:bg-[#F8FAFC]">
                  <td className="px-4 py-3 font-mono text-xs text-[#64748B]">{exec.requestId.slice(0, 20)}</td>
                  <td className="px-4 py-3"><div className="flex items-center gap-2"><span className="text-xs text-[#1E293B]">{exec.step.replace('_', ' ')}</span><span className="text-xs text-[#94A3B8]">{exec.stepNumber}/8</span></div><Progress value={stepProgress(exec.step, exec.stepNumber)} className="w-16 h-1.5" /></td>
                  <td className="px-4 py-3"><Badge className={statusColor(exec.status)}>{exec.status}</Badge></td>
                  <td className="px-4 py-3"><span className={exec.riskScore > 0.5 ? 'text-red-600 font-medium' : 'text-emerald-600'}>{exec.riskScore.toFixed(2)}</span></td>
                  <td className="px-4 py-3 text-xs text-[#64748B]">{exec.durationMs ? `${(exec.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-[#94A3B8]">{new Date(exec.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}</tbody></table>
            </div>
          </CardContent></Card>
        </TabsContent>

        {/* Security Tab */}
        <TabsContent value="security">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {secStats && [
              { label: 'Total Events', value: secStats.total, icon: Shield },
              { label: 'Blocked', value: secStats.blocked, icon: XCircle, color: 'text-red-600' },
              { label: 'Flagged', value: secStats.flagged, icon: AlertTriangle, color: 'text-amber-600' },
              { label: 'Passed', value: secStats.passed, icon: CheckCircle2, color: 'text-emerald-600' },
            ].map((s, i) => (
              <Card key={i} className="border-[#E2E8F0]"><CardContent className="p-4 flex items-center gap-3"><s.icon className={`w-8 h-8 ${s.color || 'text-[#003ABC]'} opacity-80`} /><div><p className="text-xs text-[#94A3B8]">{s.label}</p><p className="text-2xl font-bold text-[#1E293B]">{s.value}</p></div></CardContent></Card>
            ))}
          </div>
          <Card className="border-[#E2E8F0]"><CardHeader><CardTitle className="text-base">Security Rules</CardTitle></CardHeader><CardContent><p className="text-sm text-[#64748B]">Security rules protect against prompt injection, jailbreak, data leakage, tool abuse, and output validation. Block rate: <span className="font-semibold text-[#1E293B]">{secStats?.blockRate || 0}%</span></p></CardContent></Card>
        </TabsContent>

        {/* Alerts Tab */}
        <TabsContent value="alerts">
          <Card className="border-[#E2E8F0]"><CardContent className="p-0">
            <div className="max-h-[400px] overflow-y-auto">
              {alerts.length === 0 ? <div className="py-12 text-center text-[#94A3B8]">No alerts. System is healthy.</div> : alerts.map((a) => (
                <div key={a.id} className="flex items-center justify-between px-4 py-3 border-b border-[#F1F5F9] hover:bg-[#F8FAFC]">
                  <div className="flex items-center gap-3"><AlertTriangle className={`w-4 h-4 ${a.severity === 'critical' ? 'text-red-600' : a.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'}`} /><div><p className="text-sm text-[#1E293B]">{a.message}</p><p className="text-xs text-[#94A3B8]">{a.alertType} · {new Date(a.createdAt).toLocaleString()}</p></div></div>
                  {a.isAcknowledged ? <Badge className="bg-slate-100 text-slate-600">Acknowledged</Badge> : <Badge className="bg-red-100 text-red-700">Pending</Badge>}
                </div>
              ))}
            </div>
          </CardContent></Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}