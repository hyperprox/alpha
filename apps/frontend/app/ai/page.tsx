'use client'
import { ComingSoon } from '@/components/layout/ComingSoon'
export default function AIPage() {
  return (
    <ComingSoon
      title="AI Assistant"
      description="Autonomous deployment wizard — describe what you want, HyperProx builds it."
      features={[
        'Natural language deployment — "Deploy Nextcloud at cloud.mydomain.com"',
        'Full-stack automation — CT → proxy → DNS → SSL in one command',
        'Hardware-aware recommendations — VRAM fit indicator per model',
        'Ollama model library — curated models with plain-English descriptions',
        'Local AI — all inference runs on your hardware, nothing leaves the cluster',
        'Multi-model — download and switch models without restarting',
      ]}
      accent="#a78bfa"
      icon="ai"
    />
  )
}
