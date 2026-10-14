// MODULE: opencode-destinations.ts - OpenCode configuration folders whose destination BMN reads, or must not
// claim to read, shared by the destination check's tests and the full rules' refusal tests (owner decision
// 2026-10-14; the consultant's table after Astra's recheck 2)

/** One OpenCode configuration folder: its files by path, and the destination BMN reads from it. */
export interface OpenCodeFolder {
  label: string
  files: Record<string, string>
  /** OpenCode Go's own servers, with the model BMN reports when given, or unknown for this reason. */
  expected: { basis: 'default'; model?: string } | { basis: 'unknown'; reason: string | RegExp }
}

// Built rather than typed: file tools decode a typed backslash-u escape into its character.
const BACKSLASH = String.fromCharCode(92)
const escaped = (hex: string): string => `${BACKSLASH}u${hex}`
const BOM = String.fromCharCode(0xfeff)

export const OPENCODE_CONFIG = '{ "model": "opencode-go/kimi-k3" }'
const RELEASE = 'commands/team/release.md'
const TWO_PROVIDERS = 'opencode.jsonc sends the conversation to more than one provider (opencode-go, openrouter)'
const front = (body: string, opener = '---'): string => `${opener}\n${body}\n---\nShip it.\n`
const release = (text: string): Record<string, string> => ({ 'opencode.jsonc': OPENCODE_CONFIG, [RELEASE]: text })
const config = (text: string): Record<string, string> => ({ 'opencode.jsonc': text })
const known = (label: string, files: Record<string, string>, model?: string): OpenCodeFolder =>
  ({ label, files, expected: model === undefined ? { basis: 'default' } : { basis: 'default', model } })
const unknown = (label: string, files: Record<string, string>, reason: string | RegExp): OpenCodeFolder => ({ label, files, expected: { basis: 'unknown', reason } })
const unread = (label: string, text: string, why: string): OpenCodeFolder => unknown(label, release(text), `${RELEASE}: ${why}`)
const notYaml = (detail: string): string => `its front matter is not YAML BMN reads (${detail})`

/** Agent and command files: BMN reads a front matter whole, in the YAML it knows, or not at all. */
export const FRONT_MATTER_FOLDERS: readonly OpenCodeFolder[] = [
  known('a model line in the body only', release('model: openrouter/cheap\nShip it.\n')),
  known('a front matter naming no model', release(front('description: Reviews'))),
  known('the same provider', release(front('model: opencode-go/other'))),
  known('the same provider, quoted, with a variant and a comment', release(front(`"model": 'opencode-go/other#high' # comment`))),
  known('the same provider after ---yaml', release(front('model: opencode-go/other', '---yaml'))),
  known('the same provider after ---yml', release(front('model: opencode-go/other', '---yml'))),
  known('an empty front matter', release('---\n---\nShip it.\n')),
  known('a front matter of comments only', release(front('# nothing here'))),
  known('a model line in the body after the front matter closed', release('---\ndescription: Reviews\n---\nmodel: openrouter/cheap\n---\n')),
  known('the same provider with a BOM and CRLF', release(`${BOM}---yaml\r\nmodel: opencode-go/other\r\n---\r\nShip it.\r\n`)),
  known('nested settings beside a top-level model', release(front('description: Reviews\nmodel: opencode-go/kimi-k3\npermission:\n  edit: deny\n  bash:\n    "git status": allow'))),
  unknown('another provider', release(front('model: openrouter/cheap')), TWO_PROVIDERS),
  unknown('another provider after ---yaml', release(front('model: openrouter/cheap', '---yaml')), TWO_PROVIDERS),
  unknown('another provider after ---yml', release(front('model: openrouter/cheap', '---yml')), TWO_PROVIDERS),
  unknown('another provider with a BOM and CRLF', release(`${BOM}---yml\r\nmodel: openrouter/cheap\r\n---\r\nShip it.\r\n`), TWO_PROVIDERS),
  unknown('a model that names no provider', release(front('model: cheap')), `${RELEASE} names no model BMN reads as <provider>/<model>`),
  unread('a key written with an escape', front(`"${escaped('006d')}odel": openrouter/cheap`), notYaml(`unsupported escape ${BACKSLASH}u`)),
  unread('a JavaScript front matter', '---javascript\n({["mo" + "del"]: "openrouter/cheap"})\n---\nShip it.\n', 'its front matter opens with "---javascript"'),
  unread('a JSON front matter', '---json\n{"model":"openrouter/cheap"}\n---\nShip it.\n', 'its front matter opens with "---json"'),
  unread('a block scalar', front('model: >-\n  openrouter/cheap'), notYaml('unsupported YAML at ">-": anchors, aliases, tags and block scalars are not read')),
  unread('a value on the next line', front('model:\n  openrouter/cheap'), notYaml('expected ":" after key openrouter/cheap')),
  unread('a model below the top', front('options:\n  model: openrouter/cheap'), 'it names a model below the top of its front matter, or merges a map into it'),
  unread('a flow map below the top', front('options: {model: openrouter/cheap}'), 'it names a model below the top of its front matter, or merges a map into it'),
  unread('a flow map as the whole front matter', front('{model: openrouter/cheap}'), notYaml('unsupported or empty key "{model"')),
  unread('a model twice', front('model: opencode-go/kimi-k3\n"model": openrouter/cheap'), notYaml('duplicate key model')),
  unread('a complex key', front('? model\n: openrouter/cheap'), notYaml('unsupported or empty key "? model"')),
  unread('a tag', front('model: !!str openrouter/cheap'), notYaml('unsupported YAML at "!!str openrouter/che": anchors, aliases, tags and block scalars are not read')),
  unread('an anchor and a merge', front('base: &b {model: openrouter/cheap}\n<<: *b'), notYaml('unsupported YAML at "&b {model: openroute": anchors, aliases, tags and block scalars are not read')),
  unread('a merge key', front('<<: {model: openrouter/cheap}'), 'it names a model below the top of its front matter, or merges a map into it'),
  unread('a prototype key', front('__proto__:\n  model: openrouter/cheap'), 'it names a model below the top of its front matter, or merges a map into it'),
  unread('a directive', front('%YAML 1.2\nmodel: openrouter/cheap'), notYaml('unsupported or empty key "%YAML 1.2"')),
  unread('a model that is not text', front('model: [openrouter/cheap]'), 'its model is not text'),
  unread('a front matter that never closes', '---\nmodel: opencode-go/kimi-k3\nShip it.\n', 'its front matter does not close'),
  unread('a closing-prefix line before a later close', '---\nmodel: opencode-go/kimi-k3\n---unexpected\nmodel: openrouter/cheap\n---\nShip it.\n', 'its front matter closes with "---unexpected"'),
  unread('a closing-prefix line with a BOM and CRLF', `${BOM}---\r\nmodel: opencode-go/kimi-k3\r\n---unexpected\r\n---\r\n`, 'its front matter closes with "---unexpected"'),
  // OpenCode's YAML reader ends a line at a carriage return alone too (Astra recheck 3): a key after one is refused.
  unread('a comment ended by a carriage return alone', '---\n# metadata\rmodel: openrouter/cheap\n---\nShip it.\n', 'its front matter ends a line with a carriage return alone'),
  unread('a nested comment ended by a carriage return alone', '---\npermission:\n  edit: deny # metadata\rmodel: openrouter/cheap\n---\nShip it.\n', 'its front matter ends a line with a carriage return alone'),
  unread('a value ended by a carriage return alone', '---\ndescription: Reviews\rmodel: openrouter/cheap\n---\nShip it.\n', 'its front matter ends a line with a carriage return alone'),
  unread('a close hidden after a carriage return alone', '---\ndescription: Reviews\r---\nmodel: openrouter/cheap\n---\nShip it.\n', 'its front matter ends a line with a carriage return alone'),
  known('a carriage return alone in the body', release('---\ndescription: Reviews\n---\nShip\rmodel: openrouter/cheap\n')),
  // Every folder OpenCode 2 reads agent and command files from, its own and OpenCode 1's, at any depth.
  ...['agent', 'agents', 'mode', 'modes', 'command', 'commands'].flatMap((folder) => [`${folder}/review.md`, `${folder}/team/review.md`].map((path) =>
    unknown(`another provider in ${path}`, { 'opencode.jsonc': OPENCODE_CONFIG, [path]: front('description: Reviews\nmodel: "openrouter/cheap#low"') }, TWO_PROVIDERS)))
]

/** The configuration file: JSON with comments and trailing commas, read token by token, and its shapes. */
export const CONFIGURATION_FOLDERS: readonly OpenCodeFolder[] = [
  known('comments and trailing commas outside strings', config('{\n  // the model\n  "model": "opencode-go/kimi-k3", /* the title model */ "small_model": "opencode-go/kimi-mini",\n  "agents": { "review": { "model": "opencode-go/kimi-k3", }, },\n}\n')),
  known('strings that hold comment, comma and quote text', config(`{ "model": "opencode-go/k//x/*y*/,},]${BACKSLASH}"q", "agents": { "review": { "description": "see https://example.test/a,} and /* this */", "prompt": "a // b ,]" } } }`), 'opencode-go/k//x/*y*/,},]"q'),
  known('an escaped model key', config(`{ "${escaped('006d')}odel": "opencode-go/kimi-k3" }`), 'opencode-go/kimi-k3'),
  known('a line comment ended by a carriage return alone, before the model', config('{ // the model\r "model": "opencode-go/kimi-k3" }')),
  unknown('a line comment ended by a carriage return alone, before another provider', config('{"model":"opencode-go/kimi-k3",// metadata\r"agents":{"review":{"model":"openrouter/cheap"}}\n}'), TWO_PROVIDERS),
  unknown('a line comment ended by CRLF, before another provider', config('{"model":"opencode-go/kimi-k3",// metadata\r\n"agents":{"review":{"model":"openrouter/cheap"}}\n}'), TWO_PROVIDERS),
  unknown('an escaped title-model key', config(`{ "model": "opencode-go/kimi-k3", "small_${escaped('006d')}odel": "openrouter/cheap" }`), TWO_PROVIDERS),
  unknown('an escaped map name', config(`{ "model": "opencode-go/kimi-k3", "${escaped('0061')}gents": { "review": { "model": "openrouter/cheap" } } }`), TWO_PROVIDERS),
  unknown('an escaped providerID', config(`{ "model": "opencode-go/kimi-k3", "small_model": { "provider${escaped('0049')}D": "openrouter", "id": "cheap" } }`), TWO_PROVIDERS),
  unknown('an escaped baseURL', config(`{ "model": "opencode-go/kimi-k3", "providers": { "opencode-go": { "settings": { "base${escaped('0055')}RL": "https://proxy.example.test/v1" } } } }`), 'opencode.jsonc gives opencode-go its own address'),
  unknown('a model entry whose escaped name a comma rewrite would miss', config(`{ "model": "opencode-go/main,}", "providers": { "opencode-go": { "models": { "main${escaped('002c')}}": { "settings": { "baseURL": "https://proxy.example.test/v1" } } } } } }`), 'opencode.jsonc gives opencode-go/main,} its own address'),
  unknown('a key twice once decoded', config(`{ "model": "opencode-go/kimi-k3", "${escaped('006d')}odel": "openrouter/cheap" }`), /^opencode\.jsonc cannot be read \(the key "model" twice at character \d+\)$/),
  unknown('a __proto__ key', config('{ "model": "opencode-go/kimi-k3", "__proto__": { "small_model": "openrouter/cheap" } }'), /^opencode\.jsonc cannot be read \(the key "__proto__" at character \d+\)$/),
  unknown('an escaped __proto__ key', config(`{ "model": "opencode-go/kimi-k3", "__pr${escaped('006f')}to__": { "small_model": "openrouter/cheap" } }`), /^opencode\.jsonc cannot be read \(the key "__proto__" at character \d+\)$/),
  unknown('an unclosed map', config('{ "model": "opencode-go/kimi-k3"'), /^opencode\.jsonc cannot be read \(a missing "," or "}" at character \d+\)$/),
  unknown('single quotes', config("{ 'model': 'opencode-go/kimi-k3' }"), /^opencode\.jsonc cannot be read \(a key that is not a string at character \d+\)$/),
  unknown('an unclosed comment', config('{ "model": "opencode-go/kimi-k3" } /* the end'), /^opencode\.jsonc cannot be read \(an unclosed comment at character \d+\)$/),
  unknown('text after the configuration', config('{ "model": "opencode-go/kimi-k3" } x'), /^opencode\.jsonc cannot be read \(text after the configuration at character \d+\)$/),
  unknown('a configuration that is not a map', config('["opencode-go/kimi-k3"]'), 'opencode.jsonc does not hold a map'),
  unknown('agents that are not a map', config('{ "model": "opencode-go/kimi-k3", "agents": [] }'), 'opencode.jsonc agents is not a map'),
  unknown('an agent that is not a map', config('{ "model": "opencode-go/kimi-k3", "agents": { "review": "openrouter/cheap" } }'), 'opencode.jsonc agents.review is not a map'),
  unknown('a provider that is not a map', config('{ "model": "opencode-go/kimi-k3", "providers": { "opencode-go": "openrouter" } }'), 'opencode.jsonc providers.opencode-go is not a map'),
  unknown('models that are not a map', config('{ "model": "opencode-go/kimi-k3", "providers": { "opencode-go": { "models": [] } } }'), 'opencode.jsonc providers.opencode-go.models is not a map'),
  known('an empty provider entry', config('{ "model": "opencode-go/kimi-k3", "small_model": "opencode-go/kimi-mini", "providers": { "opencode-go": {} } }')),
  unknown('a provider named __proto__', config('{ "model": "opencode-go/kimi-k3", "agents": { "review": { "model": "__proto__/x" } } }'), 'opencode.jsonc sends the conversation to more than one provider (opencode-go, __proto__)'),
  unknown('variants that are not maps', config('{ "model": "opencode-go/kimi-k3", "providers": { "opencode-go": { "models": { "kimi-k3": { "variants": ["high"] } } } } }'), 'opencode.jsonc gives opencode-go/kimi-k3 its own address'),
  unknown('a model with an empty provider', config('{ "model": "/kimi-k3" }'), 'opencode.jsonc names no model'),
  unknown('a model with an empty name', config('{ "model": "opencode-go/" }'), 'opencode.jsonc names no model'),
  unknown('a model with a space', config('{ "model": "opencode-go/kimi k3" }'), 'opencode.jsonc names no model'),
  unknown('a model map with both model and id', config('{ "model": { "providerID": "opencode-go", "model": "kimi-k3", "id": "kimi-k2" } }'), 'opencode.jsonc names no model'),
  unknown('an agent model without a provider', config('{ "model": "opencode-go/kimi-k3", "agents": { "review": { "model": "kimi-k3" } } }'), 'opencode.jsonc agents.review.model names no model BMN reads as <provider>/<model>'),
  unknown('both configuration files', { 'opencode.json': OPENCODE_CONFIG, 'opencode.jsonc': OPENCODE_CONFIG }, 'opencode.json and opencode.jsonc are both there, and OpenCode reads both')
]

export const OPENCODE_FOLDERS: readonly OpenCodeFolder[] = [...FRONT_MATTER_FOLDERS, ...CONFIGURATION_FOLDERS]
