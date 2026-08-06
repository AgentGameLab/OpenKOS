import { readFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_ROSTER = {
  roles: { approver: 'the maintainer', reviewer: 'a reviewer' },
  people: [],
  identityMap: {},
  teamTerms: [],
}

let warned = false

function defaultRoster() {
  return {
    roles: { ...DEFAULT_ROSTER.roles },
    people: [],
    identityMap: {},
    teamTerms: [],
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseRoster(raw) {
  const roster = JSON.parse(raw)
  if (
    !isRecord(roster) ||
    !isRecord(roster.roles) ||
    typeof roster.roles.approver !== 'string' ||
    typeof roster.roles.reviewer !== 'string' ||
    !Array.isArray(roster.people) ||
    !roster.people.every(value => typeof value === 'string') ||
    !isRecord(roster.identityMap) ||
    !Object.values(roster.identityMap).every(value => typeof value === 'string') ||
    !Array.isArray(roster.teamTerms) ||
    !roster.teamTerms.every(value => typeof value === 'string')
  ) {
    throw new TypeError('invalid roster shape')
  }
  return {
    roles: {
      approver: roster.roles.approver,
      reviewer: roster.roles.reviewer,
    },
    people: [...roster.people],
    identityMap: Object.fromEntries(Object.entries(roster.identityMap)),
    teamTerms: [...roster.teamTerms],
  }
}

function warnOnce(file, error) {
  if (warned) return
  warned = true
  console.error(`[kos-roster] unable to load ${file}: ${error.message}; using built-in default`)
}

export function loadRoster() {
  const file = process.env.KOS_ROSTER || (
    process.env.KOS_DATA_ROOT
      ? path.join(process.env.KOS_DATA_ROOT, 'kos-roster.json')
      : null
  )
  if (!file) return defaultRoster()

  try {
    return parseRoster(readFileSync(file, 'utf-8'))
  } catch (error) {
    warnOnce(file, error)
    return defaultRoster()
  }
}
