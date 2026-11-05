export type GpuVendor = 'nvidia' | 'amd' | 'intel'
export interface Gpu { vendor: GpuVendor; kind: 'integrated' | 'dedicated'; id: string; name: string }
export interface NodeHardware {
  node: string | null
  source: 'probe' | 'proxmox-api'
  gpus: Gpu[]
  dri: string[]
  nvidiaSmi: boolean | null
  rapl: 'none' | 'readable' | 'root-only' | null
  raplDomains: string[]
  nodeExporter: 'running' | 'installed' | 'absent' | null
  docker: boolean | null
  python3: boolean | null
  intelGpuTop: boolean | null
  intelExporter: 'running' | 'absent' | null
  nvidiaExporter: 'running' | 'absent' | null
  ceph: boolean | null
  arch: string | null
  pve: string | null
  /** Can containers use the built-in graphics: render nodes 0666 (open), not (closed), or no built-in graphics (none). */
  igpuAccess: 'open' | 'closed' | 'none' | null
  /** HyperProx's 99-hyperprox-igpu.rules is present. */
  igpuRule: boolean | null
}
export type StepId = 'node-exporter' | 'rapl' | 'intel-gpu-exporter' | 'nvidia-gpu-exporter' | 'igpu-access' | 'igpu-access-undo'
export type QuestionId = 'node-health' | 'power' | 'gpu' | 'igpu-access' | 'charts' | 'proxmox-metrics' | 'dns' | 'ai'
export interface Question { id: QuestionId; nodeWork: boolean; default: boolean; optional?: boolean; ask: string; what: string; notes?: string[] }
export type Answers = Partial<Record<QuestionId, boolean>>
export interface PlanItem { node: string; step: StepId }
export interface StepResult extends PlanItem { label: string; status: 'done' | 'already' | 'skipped' | 'failed'; reason: string }
export interface Target { targets: string[]; labels: { node: string } }
export interface Check { id: QuestionId; node?: string; status: 'ok' | 'failed' | 'waiting'; reason: string }

export const NODE_DIR: string
export const STEPS: StepId[]
export const STEP_LABEL: Record<StepId, string>
export const QUESTIONS: Question[]
export const AI_MODEL: string
export function probeScript(): string
export function stepScript(step: StepId): string
export function parseProbe(text: string, node?: string): NodeHardware
export function classifyPci(rows: unknown): Gpu[]
export function fromProxmox(node: string, pciRows: unknown, extra?: Partial<NodeHardware>): NodeHardware
export function parseResult(output: string, code?: number): { status: StepResult['status']; reason: string }
export function summarise(nodes: NodeHardware[]): string
export function gpuWords(g: Gpu): string
export function gpuGap(n: NodeHardware): string | null
export function applicableQuestions(nodes: NodeHardware[], opts?: { charts?: boolean }): Question[]
export function defaultAnswers(questions?: Question[]): Answers
export function planNodeWork(answers: Answers, nodes: NodeHardware[]): PlanItem[]
export function runNodeWork(plan: PlanItem[], exec: (node: string, script: string) => Promise<{ code: number; output: string }>,
  onEvent?: (e: any) => void): Promise<StepResult[]>
export function targetsFor(nodes: NodeHardware[], addr?: (node: string) => string, opts?: { cephMgrs?: Set<string> }): Record<string, Target[]>
export function mergeTargets(existing: Target[], wanted: Target[]): { merged: Target[]; added: string[] }
export function verifyOutcome(answers: Answers, nodes: NodeHardware[], query: (expr: string) => Promise<Array<{ node: string; value: number }>>): Promise<Check[]>
