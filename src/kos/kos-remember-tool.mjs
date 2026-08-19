import { z } from 'zod'

export const kosRememberInputSchema = {
  content: z.string().describe('memory 正文 markdown'),
  type: z.enum(['rule', 'playbook', 'decision', 'feedback', 'reference', 'incident', 'correction']),
  slug: z.string().describe('文件名 slug'),
  scope: z.enum(['personal', 'team']).optional(),
  tags: z.array(z.string()).optional(),
  cues: z.object({
    paths: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    cmds: z.array(z.string()).optional(),
    entities: z.array(z.string()).optional(),
  }).optional().describe('机械召回 cues（paths/tools/cmds/entities 四键；2026-08-02 前 MCP schema 漏了此字段导致传不了）'),
  supersedes: z.string().optional(),
  lastCorrectedByAMeng: z.string().nullable().optional(),
  authoritativeSources: z.array(z.string()).optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  maturity: z.string().optional(),
  status: z.enum(['deprecated', 'active']).optional(),
  visibility: z.enum(['private', 'department', 'company']).optional(),
  mode: z.enum(['sandbox', 'ranked']).optional(),
  outputType: z.enum(['rule', 'playbook', 'adr', 'commit', 'review', 'kg_entry']).optional(),
  deptId: z.enum(['AI', 'Game', 'QA', 'Design', 'BD']).optional(),
  draft: z.boolean().optional(),
  confirmNew: z.boolean().optional(),
  dedupReason: z.string().optional(),
  updateTarget: z.string().optional().describe('含 / 时 = 仓内相对路径显式覆盖写入目标（限 team-memory/ 与 docs/architecture/ 下已存在 .md；ADR 摘要卡/全文卡并存时必填）；裸 slug 仅声明「这是更新」跳过去重闸'),
}

export async function runKosRemember(args, dependencies = {}) {
  const remember = dependencies.remember
    ?? (await import('./kos-remember.mjs')).remember
  return await remember(args)
}

export async function formatKosRememberResponse(args, dependencies = {}) {
  try {
    const result = await runKosRemember(args, dependencies)
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    }
  }
}

export async function handleKosRememberRequest(args, dependencies = {}) {
  const formatResponse = dependencies.formatResponse ?? formatKosRememberResponse
  const emitMetric = dependencies.emitMetric ?? (() => {})
  const now = dependencies.now ?? Date.now
  const t0 = now()
  let ok = false

  try {
    const response = await formatResponse(args)
    ok = response != null && response.isError !== true
    return response
  } finally {
    emitMetric(
      'kos_remember',
      { type: args.type, slug: args.slug },
      now() - t0,
      ok,
    )
  }
}
