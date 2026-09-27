// MODULE: model-origin.ts - the country of the company behind a session's model, from hook-reported facts
/**
 * A flag names the model's maker, not where it is hosted. The facts arrive through `hook.observe`:
 * the API host the agent's own environment names, and the model name its payload carries. The host
 * wins over the name because vendors serve their own models behind other names (Z.ai serves GLM
 * behind Claude aliases); routers, clouds and local servers never decide; with no host at all the
 * agent's default provider speaks. An unknown host with an unknown model shows nothing rather than a
 * guess.
 */

/** The agents whose hooks can report model facts; `terminal` notices never carry any. */
export type ModelOriginAgent = 'claude' | 'codex' | 'opencode' | 'cursor'

export interface ModelOriginFacts {
  agent: ModelOriginAgent
  /** Hostname only, as `bmn hook` parsed it from the agent's base-URL variable; null when unset. */
  apiHost: string | null
  /** The model name the hook payload carried, trimmed; null when the payload had none. */
  model: string | null
}

/** ISO 3166-1 alpha-2 codes of the countries in the table. */
export type ModelOriginCountry = 'US' | 'CN' | 'FR' | 'DE' | 'CA' | 'KR' | 'JP'

/** The plain country name a tooltip reads, one per table country. */
export const MODEL_ORIGIN_COUNTRY_NAMES: Readonly<Record<ModelOriginCountry, string>> = Object.freeze({
  US: 'the United States',
  CN: 'China',
  FR: 'France',
  DE: 'Germany',
  CA: 'Canada',
  KR: 'South Korea',
  JP: 'Japan'
})

/**
 * One model-name token. A bare word matches at a word boundary and must end there or at a digit or
 * punctuation (`qwen3`, `abab6.5`); a shape is a case-insensitive prefix the rest of the word may
 * extend (`step-2`, `step-2-mini`, `command-r7b-12-2024`), so the short and ambiguous words the
 * epic names never match alone.
 */
interface ModelNameToken {
  word: string
  shape?: RegExp
}

interface ModelOriginRow {
  country: ModelOriginCountry
  hosts: readonly string[]
  tokens: readonly ModelNameToken[]
}

/**
 * The one data table. The four hosts the epic marked "from memory" were checked against vendor API
 * docs during implementation (Xiaomi MiMo `platform.xiaomimimo.com`, PLaMo
 * `api.platform.preferredai.jp`, Hunyuan `api.hunyuan.cloud.tencent.com`, CLOVA Studio
 * `clovastudio.stream.ntruss.com`). Beyond the epic's table, Alibaba's international DashScope
 * (`dashscope-intl.aliyuncs.com`) and Moonshot's Kimi Code (`api.kimi.com`, `api.kimi.ai`) are
 * where their Anthropic-compatible endpoints for Claude Code live, so a Claude alias served there
 * still reads as its real maker (checked 2026-09-27: docs.qwencloud.com, kimi.com/code/docs).
 */
export const MODEL_ORIGIN_TABLE: readonly ModelOriginRow[] = Object.freeze([
  Object.freeze({
    country: 'US',
    hosts: Object.freeze([
      'anthropic.com', 'openai.com', 'openai.azure.com', 'generativelanguage.googleapis.com',
      'x.ai', 'perplexity.ai'
    ]),
    tokens: Object.freeze([
      { word: 'claude' }, { word: 'gpt' }, { word: 'chatgpt' }, { word: 'codex' }, { word: 'gemini' }, { word: 'gemma' },
      { word: 'grok' }, { word: 'llama' }, { word: 'nova' }, { word: 'sonar' },
      { word: 'o', shape: /^o\d/i }, { word: 'phi', shape: /^phi-?\d/i }
    ])
  }),
  Object.freeze({
    country: 'CN',
    hosts: Object.freeze([
      'z.ai', 'bigmodel.cn', 'moonshot.cn', 'moonshot.ai', 'minimax.io', 'minimaxi.com',
      'deepseek.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'kimi.com', 'kimi.ai',
      'xiaomimimo.com', 'volces.com',
      'baidubce.com', 'stepfun.com', 'hunyuan.cloud.tencent.com'
    ]),
    tokens: Object.freeze([
      { word: 'glm' }, { word: 'chatglm' }, { word: 'kimi' }, { word: 'moonshot' }, { word: 'minimax' },
      { word: 'abab' }, { word: 'mimo' }, { word: 'xiaomi' }, { word: 'qwen' }, { word: 'qwq' },
      { word: 'deepseek' }, { word: 'doubao' }, { word: 'ernie' }, { word: 'hunyuan' },
      { word: 'baichuan' }, { word: 'seed', shape: /^seed-\d/i }, { word: 'step', shape: /^step-?\d/i },
      { word: 'yi', shape: /^yi-/i }
    ])
  }),
  Object.freeze({
    country: 'FR',
    hosts: Object.freeze(['mistral.ai']),
    tokens: Object.freeze([
      { word: 'mistral' }, { word: 'mixtral' }, { word: 'ministral' }, { word: 'codestral' },
      { word: 'devstral' }, { word: 'magistral' }, { word: 'pixtral' }
    ])
  }),
  Object.freeze({
    country: 'DE',
    hosts: Object.freeze(['aleph-alpha.com']),
    tokens: Object.freeze([{ word: 'luminous' }, { word: 'pharia' }])
  }),
  Object.freeze({
    country: 'CA',
    hosts: Object.freeze(['cohere.com', 'cohere.ai']),
    tokens: Object.freeze([{ word: 'command', shape: /^command-[ra](?![a-z])/i }, { word: 'aya' }])
  }),
  Object.freeze({
    country: 'KR',
    hosts: Object.freeze(['upstage.ai', 'clovastudio.stream.ntruss.com']),
    tokens: Object.freeze([{ word: 'exaone' }, { word: 'solar', shape: /^solar-/i }, { word: 'hyperclova' }])
  }),
  Object.freeze({
    country: 'JP',
    hosts: Object.freeze(['sakana.ai', 'platform.preferredai.jp']),
    tokens: Object.freeze([{ word: 'plamo' }, { word: 'sarashina' }, { word: 'tsuzumi' }])
  })
])

/**
 * Routers, clouds and local servers (`openrouter.ai`, `amazonaws.com`, `azure.com` beyond
 * `openai.azure.com`, `groq.com`, `together.ai`, `together.xyz`, `fireworks.ai`, `localhost`,
 * `127.0.0.1`) appear in no host row on purpose: they carry many makers' models, so the host can
 * never say who made the one running. Multi-maker platforms a vendor also serves its own models
 * from (Vertex AI's `aiplatform.googleapis.com`, SiliconFlow's `siliconflow.cn`) are left out of
 * the first-party rows for the same reason — the model name decides, and a Google or Qwen model
 * still reaches its own country by its token.
 */

/** The country an agent falls back to when its environment names no API host at all. */
const DEFAULT_PROVIDER_COUNTRIES: Readonly<Record<ModelOriginAgent, ModelOriginCountry | null>> = Object.freeze({
  claude: 'US',
  codex: 'US',
  opencode: null,
  // Cursor's Auto reports the model as `default`, and Cursor serves every maker's models.
  cursor: null
})

function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`)
}

/**
 * Where a token's word matches: anywhere at a word boundary, or only at the segment's start. A
 * host-less name usually begins with its maker (`qwen3-coder-plus`), so a start match is tried
 * everywhere first and wins over a later word: `DeepSeek-R1-Distill-Llama-70B` is DeepSeek's, not
 * Meta's, whatever order the rows are checked in.
 */
function tokenWordStart(token: ModelNameToken, name: string): number {
  const found = name.match(new RegExp(`\\b${token.word}(?![a-zA-Z])`, 'i'))
  return found === null || found.index === undefined ? -1 : found.index
}

function tokenMatches(token: ModelNameToken, name: string, atStartOnly: boolean): boolean {
  let offset = 0
  while (offset <= name.length) {
    const start = tokenWordStart(token, name.slice(offset))
    if (start < 0) return false
    const at = offset + start
    if (token.shape === undefined || token.shape.test(name.slice(at))) {
      return !atStartOnly || at === 0
    }
    offset = at + 1
  }
  return false
}

/** The last `/`-separated segment, so a router prefix (`xiaomi/mimo-7b`) never hides the model. */
function modelNameSegment(model: string): string {
  const segments = model.split('/')
  return segments[segments.length - 1] ?? model
}

/**
 * Classify one observation into the maker's country, or null when nothing known speaks. First-party
 * host, then model name (start-anchored token first, then any token), then the agent's default
 * provider when no host was reported; a neutral or unknown host that the model name cannot classify
 * yields null rather than a guess.
 */
export function modelOrigin(facts: ModelOriginFacts): ModelOriginCountry | null {
  // A fully qualified name may end in the root's dot (`api.z.ai.`), which names the same host.
  const host = facts.apiHost?.toLowerCase().replace(/\.$/, '') ?? null
  if (host !== null) {
    for (const row of MODEL_ORIGIN_TABLE) {
      if (row.hosts.some((entry) => hostMatches(host, entry))) return row.country
    }
  }
  const name = facts.model === null || facts.model.trim() === '' ? null : modelNameSegment(facts.model.trim())
  if (name !== null) {
    for (const atStartOnly of [true, false]) {
      for (const row of MODEL_ORIGIN_TABLE) {
        if (row.tokens.some((token) => tokenMatches(token, name, atStartOnly))) return row.country
      }
    }
  }
  if (host === null) return DEFAULT_PROVIDER_COUNTRIES[facts.agent]
  return null
}

/** The regional-indicator flag of a table country, drawn from its code: `countryFlag('CN') === '🇨🇳'`. */
export function countryFlag(country: ModelOriginCountry): string {
  return String.fromCodePoint(...[...country].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65))
}
