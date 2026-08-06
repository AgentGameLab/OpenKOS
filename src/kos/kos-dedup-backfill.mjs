#!/usr/bin/env node
import { loadIndex, refreshIndex, saveIndex } from './kos-dedup.mjs'

const idx = loadIndex()
const result = await refreshIndex(idx)
saveIndex(idx)
console.log(`embedded=${result.embedded} total=${result.total}`)
