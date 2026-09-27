// MODULE: model-origin.test.ts - table, precedence and false-positive coverage for modelOrigin
import { describe, expect, it } from 'vitest'
import { countryFlag, MODEL_ORIGIN_TABLE, modelOrigin } from './model-origin'

const classify = (agent: 'claude' | 'codex' | 'opencode', apiHost: string | null, model: string | null) =>
  modelOrigin({ agent, apiHost, model })

describe('modelOrigin table rows', () => {
  it('classifies every first-party host and its subdomains', () => {
    const hostCases: Array<[string, string, string]> = [
      ['anthropic.com', 'US', 'api.anthropic.com'],
      ['openai.com', 'US', 'api.openai.com'],
      ['openai.azure.com', 'US', 'my-deployment.openai.azure.com'],
      ['generativelanguage.googleapis.com', 'US', 'generativelanguage.googleapis.com'],
      ['x.ai', 'US', 'api.x.ai'],
      ['perplexity.ai', 'US', 'api.perplexity.ai'],
      ['z.ai', 'CN', 'api.z.ai'],
      ['bigmodel.cn', 'CN', 'open.bigmodel.cn'],
      ['moonshot.cn', 'CN', 'api.moonshot.cn'],
      ['moonshot.ai', 'CN', 'api.moonshot.ai'],
      ['minimax.io', 'CN', 'api.minimax.io'],
      ['minimaxi.com', 'CN', 'api.minimaxi.com'],
      ['deepseek.com', 'CN', 'api.deepseek.com'],
      ['dashscope.aliyuncs.com', 'CN', 'coding-intl.dashscope.aliyuncs.com'],
      ['dashscope-intl.aliyuncs.com', 'CN', 'api.dashscope-intl.aliyuncs.com'],
      ['kimi.com', 'CN', 'api.kimi.com'],
      ['kimi.ai', 'CN', 'api.kimi.ai'],
      ['xiaomimimo.com', 'CN', 'platform.xiaomimimo.com'],
      ['volces.com', 'CN', 'ark.cn-beijing.volces.com'],
      ['baidubce.com', 'CN', 'aip.baidubce.com'],
      ['stepfun.com', 'CN', 'api.stepfun.com'],
      ['hunyuan.cloud.tencent.com', 'CN', 'api.hunyuan.cloud.tencent.com'],
      ['mistral.ai', 'FR', 'api.mistral.ai'],
      ['aleph-alpha.com', 'DE', 'api.aleph-alpha.com'],
      ['cohere.com', 'CA', 'api.cohere.com'],
      ['cohere.ai', 'CA', 'api.cohere.ai'],
      ['upstage.ai', 'KR', 'api.upstage.ai'],
      ['clovastudio.stream.ntruss.com', 'KR', 'clovastudio.stream.ntruss.com'],
      ['sakana.ai', 'JP', 'api.sakana.ai'],
      ['platform.preferredai.jp', 'JP', 'api.platform.preferredai.jp']
    ]
    for (const [host, expected, subdomain] of hostCases) {
      expect(classify('claude', host, null), host).toBe(expected)
      expect(classify('claude', subdomain, null), subdomain).toBe(expected)
    }
    // A host that merely ends like a table entry is not a subdomain of it.
    expect(classify('claude', 'evil-z.ai.example.com', null)).toBeNull()
    expect(classify('claude', 'notanthropic.com', null)).toBeNull()
  })

  it('classifies every model-name token, through router prefixes and mixed case', () => {
    const tokenCases: Array<[string, string]> = [
      ['claude-opus-5', 'US'], ['Claude-Sonnet-5', 'US'], ['gpt-5.2', 'US'], ['GPT-6', 'US'],
      ['o3-mini', 'US'], ['O4-MINI', 'US'], ['codex-mini', 'US'], ['gemini-3-pro', 'US'],
      ['gemma-3-27b', 'US'], ['grok-4', 'US'], ['llama-4-maverick', 'US'], ['llama-4', 'US'],
      ['phi-4', 'US'], ['Phi-3.5', 'US'], ['nova-pro-v1', 'US'], ['sonar-reasoning-pro', 'US'],
      ['glm-5.3', 'CN'], ['GLM-4.6', 'CN'], ['chatglm3', 'CN'], ['kimi-k2', 'CN'], ['Kimi-K2', 'CN'],
      ['moonshot-v1-128k', 'CN'], ['MiniMax-M2', 'CN'], ['abab6.5-chat', 'CN'], ['abab6.5', 'CN'],
      ['mimo-7b', 'CN'], ['qwen3-coder', 'CN'], ['Qwen3-Max', 'CN'], ['qwq-32b', 'CN'],
      ['deepseek-v3.2', 'CN'], ['DeepSeek-R1', 'CN'], ['doubao-seed-1.6', 'CN'], ['ernie-5.0', 'CN'],
      ['hunyuan-turbos-latest', 'CN'], ['step-2-16k', 'CN'], ['STEP-3', 'CN'], ['yi-34b-chat', 'CN'],
      ['Yi-Lightning', 'CN'], ['baichuan-m2', 'CN'], ['seed-1.6-flash', 'CN'],
      ['mistral-large-2', 'FR'], ['mixtral-8x22b', 'FR'], ['ministral-8b', 'FR'],
      ['codestral-latest', 'FR'], ['devstral-medium', 'FR'], ['magistral-medium', 'FR'],
      ['pixtral-large', 'FR'],
      ['luminous-supreme', 'DE'], ['pharia-1', 'DE'],
      ['command-r-plus', 'CA'], ['command-a-02', 'CA'], ['COMMAND-R7B-12-2024', 'CA'],
      ['aya-expanse-32b', 'CA'],
      ['exaone-deep-32b', 'KR'], ['solar-pro', 'KR'], ['SOLAR-Plus', 'KR'],
      ['hyperclova-x-SEED', 'KR'],
      ['plamo-3-0-prime', 'JP'], ['sarashina2-13b', 'JP'], ['tsuzumi-8b', 'JP']
    ]
    for (const [model, expected] of tokenCases) {
      // A router prefix never hides the model: the last segment is what speaks.
      expect(classify('opencode', 'openrouter.ai', model), model).toBe(expected)
      expect(classify('opencode', 'openrouter.ai', `some-router/${model}`), model).toBe(expected)
      expect(classify('opencode', 'openrouter.ai', `accounts/fireworks/models/${model}`), model).toBe(expected)
    }
  })

  it('keeps every table country reachable and flags it with regional indicators', () => {
    expect(MODEL_ORIGIN_TABLE.map((row) => row.country)).toEqual(['US', 'CN', 'FR', 'DE', 'CA', 'KR', 'JP'])
    expect(countryFlag('US')).toBe('🇺🇸')
    expect(countryFlag('CN')).toBe('🇨🇳')
    expect(countryFlag('FR')).toBe('🇫🇷')
    expect(countryFlag('DE')).toBe('🇩🇪')
    expect(countryFlag('CA')).toBe('🇨🇦')
    expect(countryFlag('KR')).toBe('🇰🇷')
    expect(countryFlag('JP')).toBe('🇯🇵')
  })
})

describe('modelOrigin precedence', () => {
  it('lets a first-party host win over the model name, both ways', () => {
    // Z.ai serves GLM behind Claude aliases: the host, not the name, says who made it.
    expect(classify('claude', 'api.z.ai', 'claude-sonnet-4')).toBe('CN')
    expect(classify('codex', 'api.mistral.ai', 'gpt-6')).toBe('FR')
  })

  it('never lets a router or cloud decide; the model name does', () => {
    expect(classify('claude', 'openrouter.ai', 'moonshotai/kimi-k2')).toBe('CN')
    expect(classify('claude', 'openrouter.ai', 'meta-llama/llama-4')).toBe('US')
    expect(classify('claude', 'api.groq.com', 'kimi-k2-instruct')).toBe('CN')
    expect(classify('claude', 'api.groq.com', 'llama-4-scout')).toBe('US')
    expect(classify('claude', 'api.together.ai', 'Qwen/Qwen3-Coder')).toBe('CN')
    expect(classify('claude', 'api.fireworks.ai', 'accounts/fireworks/models/qwen3')).toBe('CN')
    expect(classify('claude', 'localhost', 'mimo-7b')).toBe('CN')
    expect(classify('claude', '127.0.0.1', 'llama-4')).toBe('US')
    // Multi-maker vendor clouds follow the same rule (Sol consultation, 2026-09-27): the model
    // name decides, so a partner model on Vertex or SiliconFlow keeps its own maker's flag.
    expect(classify('claude', 'aiplatform.googleapis.com', 'mistral-large-2')).toBe('FR')
    expect(classify('claude', 'aiplatform.googleapis.com', 'gemini-3-pro')).toBe('US')
    expect(classify('claude', 'api.siliconflow.cn', 'meta-llama/llama-4')).toBe('US')
    expect(classify('claude', 'api.siliconflow.cn', 'qwen3-coder')).toBe('CN')
  })

  it('falls back to the agent default only when no host was reported', () => {
    expect(classify('claude', null, null)).toBe('US')
    expect(classify('codex', null, null)).toBe('US')
    expect(classify('opencode', null, null)).toBeNull()
    expect(classify('opencode', null, 'kimi-k2')).toBe('CN')
    // A host that was reported but matches nothing silences the default: no guesses.
    expect(classify('claude', 'llm.internal.example', null)).toBeNull()
    expect(classify('claude', 'openrouter.ai', null)).toBeNull()
    expect(classify('claude', 'llm.internal.example', 'custom-tuned-model')).toBeNull()
  })

  it('reads a host with the root dot as the same host, and the spellings routers use', () => {
    // A Claude alias behind Z.ai's fully qualified name is still GLM, not a guess from the alias.
    expect(classify('claude', 'api.z.ai.', 'claude-sonnet-4-5')).toBe('CN')
    expect(classify('claude', 'dashscope-intl.aliyuncs.com', 'claude-opus-4-5')).toBe('CN')
    expect(classify('opencode', 'localhost', 'phi4')).toBe('US')
    expect(classify('opencode', 'localhost', 'chatgpt-4o-latest')).toBe('US')
    expect(classify('opencode', 'openrouter.ai', 'stepfun-ai/step3')).toBe('CN')
  })

  it('prefers the maker named at the start of the model name', () => {
    // DeepSeek's distilled Llama is DeepSeek's, whatever word comes later.
    expect(classify('claude', 'openrouter.ai', 'DeepSeek-R1-Distill-Llama-70B')).toBe('CN')
    expect(classify('claude', 'openrouter.ai', 'qwen3-coder-plus')).toBe('CN')
  })

  it('rejects the short-token false positives the epic names', () => {
    const never: Array<[string]> = [
      ['solar'], ['step'], ['command'], ['yi'], ['phi'], ['seed'], ['o'],
      ['ababcd'], ['philosophy-essays'], ['command-line-runner'], ['command-runner'],
      ['step-function-builder'], ['stepwise'],
      ['only1'], ['to4-mini']
    ]
    for (const [model] of never) {
      expect(classify('opencode', 'openrouter.ai', model), model).toBeNull()
    }
  })

  it('documents what the shape and plain-word rules accept beyond the bare word', () => {
    // A shape matches any continuation of its prefix, and a plain word matches wherever a word
    // begins: that breadth is the price of `qwen3` and `abab6.5`, and these are its known edges.
    expect(classify('opencode', 'openrouter.ai', 'yi-light')).toBe('CN')
    expect(classify('opencode', 'openrouter.ai', 'nova-fitness-plan')).toBe('US')
  })
})
