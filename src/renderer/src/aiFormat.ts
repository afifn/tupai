// Re-export so existing renderer imports keep working. The formatting rules live
// in shared/aiFormat.ts, where the test suite can run them in plain Node.
export {
  extractSqlBlocks,
  normalizeProse,
  renderInline,
  splitFences,
  type InlinePart,
  type Segment
} from '@shared/aiFormat'
export { stripToolCalls, type CleanedContent } from '@shared/aiToolCalls'
