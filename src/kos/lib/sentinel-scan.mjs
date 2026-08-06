#!/usr/bin/env node
// sentinel-scan.mjs — KOS 内容入库前的零 LLM 安全哨兵。
// 只做确定性正则扫描：提示注入/危险 shell 为 fatal，凭据形状为 warn。

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ZERO_WIDTH = /[\u180E\u200B-\u200D\u2060\uFEFF]/
const IGNORE_DIRECTIVE = /\b(?:ignore|disregard|forget|bypass)\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|messages?|context)\b/i
const SYSTEM_OVERRIDE = /\b(?:ignore|disregard|override|bypass|replace|reveal|show|print|dump|expose)\s+(?:all\s+)?(?:the\s+)?(?:system(?:[-\s]+prompt|[-\s]+message)?|developer[-\s]+instructions?|hidden[-\s]+instructions?)\b/i
const HTML_IMPERATIVE = /^\s*(?:please\s+)?(?:ignore|disregard|override|bypass|follow|execute|run|reveal|show|print|output|delete|remove|send|exfiltrate|do)\b/i
const BROAD_RM = /\brm\s+(?:-[^\s]*[rf][^\s]*|--(?:recursive|force)(?:\s+--(?:recursive|force))?)\s+(?:\/(?:\s|$)|~(?:[\\/]|$)|\.(?:[\\/])?(?:\s|$)|\.\.(?:[\\/])?(?:\s|$)|\*|\/\*|[A-Za-z]:[\\/](?:\*|$))/i
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh)\b/i
const ENCODED_EVAL = /\beval\s*(?:\(\s*)?[^;\n]{0,200}\b(?:base64|base-64|xxd\s+-r\s+-p|fromhex|unhexlify)\b/i
const FORK_BOMB = /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
const AWS_KEY = /AKIA[0-9A-Z]{16}/
const OPENAI_KEY = /sk-[A-Za-z0-9]{20,}/
const GITHUB_TOKEN = /ghp_[A-Za-z0-9]{20,}/
const PRIVATE_KEY = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/
const CREDENTIAL_ASSIGNMENT = /\b(?:password|token)\s*[:=]\s*(['"]?)([^\s'"]+)\1/i

function excerpt(line) {
  return String(line || '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

// 警告必须可诊断，但扫描结果不能反过来泄露疑似密钥。
function credentialExcerpt(line) {
  return excerpt(line)
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA<redacted>')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-<redacted>')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_<redacted>')
    .replace(/(\b(?:password|token)\s*[:=]\s*)(['"]?)[^\s'"]+\2/gi, '$1<redacted>')
}

function isLiteralCredential(match) {
  const value = match[2] || ''
  return !/^(?:\$|<|\{|\[|redacted\b|your_|example\b|xxx\b|null\b|undefined\b)/i.test(value)
}

/**
 * 对文本作离线确定性扫描。
 * @param {string} text
 * @returns {{findings: Array<{severity: 'fatal'|'warn', rule: string, line: number, excerpt: string}>}}
 */
export function scanContent(text) {
  const source = String(text || '')
  const lines = source.split(/\r?\n/)
  const findings = []
  const seen = new Set()
  const add = (severity, rule, line, lineText, redact = false) => {
    const key = `${severity}:${rule}:${line}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ severity, rule, line, excerpt: redact ? credentialExcerpt(lineText) : excerpt(lineText) })
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const lineNumber = index + 1
    if (ZERO_WIDTH.test(line)) add('fatal', 'zero-width-unicode', lineNumber, line)
    if (IGNORE_DIRECTIVE.test(line)) add('fatal', 'prompt-injection-ignore', lineNumber, line)
    if (SYSTEM_OVERRIDE.test(line)) add('fatal', 'system-prompt-override', lineNumber, line)
    if (BROAD_RM.test(line)) add('fatal', 'dangerous-rm-broad-path', lineNumber, line)
    if (PIPE_TO_SHELL.test(line)) add('fatal', 'download-piped-to-shell', lineNumber, line)
    if (ENCODED_EVAL.test(line)) add('fatal', 'encoded-eval', lineNumber, line)
    if (FORK_BOMB.test(line)) add('fatal', 'fork-bomb', lineNumber, line)
    if (AWS_KEY.test(line)) add('warn', 'aws-access-key-shape', lineNumber, line, true)
    if (OPENAI_KEY.test(line)) add('warn', 'api-key-shape', lineNumber, line, true)
    if (GITHUB_TOKEN.test(line)) add('warn', 'github-token-shape', lineNumber, line, true)
    if (PRIVATE_KEY.test(line)) add('warn', 'private-key-marker', lineNumber, line, true)
    const assignment = line.match(CREDENTIAL_ASSIGNMENT)
    if (assignment && isLiteralCredential(assignment)) add('warn', 'literal-credential-assignment', lineNumber, line, true)
  }

  for (const match of source.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (!HTML_IMPERATIVE.test(match[1])) continue
    const lineNumber = source.slice(0, match.index).split('\n').length
    add('fatal', 'html-comment-imperative', lineNumber, match[0])
  }

  return { findings }
}

function markdownFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(fullPath))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(fullPath)
  }
  return files
}

function runCli() {
  const argv = process.argv.slice(2)
  const dirIndex = argv.indexOf('--dir')
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : null
  if (!dir || dir.startsWith('--')) {
    console.error('Usage: node sentinel-scan.mjs --dir <path>')
    process.exit(1)
  }

  let files
  try {
    files = markdownFiles(dir)
  } catch (err) {
    console.error(`[sentinel-scan] 无法扫描 ${dir}: ${err.message}`)
    process.exit(2)
  }

  const findings = []
  for (const file of files) {
    try {
      for (const finding of scanContent(readFileSync(file, 'utf8')).findings) {
        findings.push({ file: relative(dir, file).replace(/\\/g, '/'), ...finding })
      }
    } catch (err) {
      console.error(`[sentinel-scan] 无法读取 ${file}: ${err.message}`)
      process.exitCode = 2
    }
  }
  for (const finding of findings) {
    console.log(`[${finding.severity}] ${finding.file}:${finding.line} ${finding.rule} — ${finding.excerpt}`)
  }
  const fatalCount = findings.filter(finding => finding.severity === 'fatal').length
  const warnCount = findings.filter(finding => finding.severity === 'warn').length
  console.log(`[sentinel-scan] files=${files.length} fatal=${fatalCount} warn=${warnCount}`)
  if (fatalCount) process.exitCode = 1
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) runCli()
