// MODULE: bmn-opencode-plugin.mjs - the bmn command line behind bin/bmn: the agents its hooks serve and the OpenCode 2 terminal plugin `bmn hooks install opencode` writes

export { HOOK_AGENTS, OPENCODE_PLUGIN }

const HOOK_AGENTS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' }
/**
 * OpenCode 2's terminal plugin, written as bmn/tui.ts and named by its folder in cli.json's "plugins"
 * (2.0.28, measured 2026-10-14). It translates OpenCode 2's events into the OpenCode 1 shapes `bmn hook opencode` reads.
 */
const OPENCODE_PLUGIN = `// MODULE: bmn.ts - BMN's OpenCode 2 terminal plugin: tells BMN what this terminal's session asks and answers taps from the phone
// Shipped by BMN. Reinstall with bmn hooks install opencode.
// OpenCode 2 runs this terminal plugin inside the terminal's own process (cli.json "plugins"), so it sees
// BMN's variables and the session this terminal shows, while the server it hears may serve other terminals.
import { spawn } from "node:child_process"

type Option = { value?: unknown; label?: string }
type Field = { key: string; type?: string; options?: Option[]; custom?: boolean }
type Answer = { requestRef?: string; kind?: string; answers?: string[][]; reply?: string }

// One bmn command under a hard deadline; it never rejects, so a missing or stalled BMN costs OpenCode nothing.
const run = (args: string[], env: Record<string, string | undefined>, input?: string) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    let stdout = ""
    try {
      const child = spawn("timeout", args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] })
      child.stdout?.on("data", (chunk) => { if (stdout.length < 1048576) stdout += String(chunk) })
      child.stdin?.on("error", () => undefined)
      child.on("error", () => resolve({ code: null, stdout: "" }))
      child.on("close", (code) => resolve({ code, stdout }))
      if (input !== undefined) child.stdin?.end(input)
    } catch {
      resolve({ code: null, stdout: "" })
    }
  })

// The server's own refusals, as the 2.0.28 client names them: nothing was applied. A transport or decoding
// failure (HttpClientError, ClientError, SchemaError) may hide a reply that landed.
const REFUSALS = [
  "LocationNotFoundError", "InvalidRequestError", "UnauthorizedError", "SessionNotFoundError", "PermissionNotFoundError",
  "FormNotFoundError", "FormAlreadySettledError", "FormInvalidAnswerError",
]
const refused = (error: any) => REFUSALS.includes(error?._tag)

export default {
  id: "bmn",
  setup(context: any) {
    if (!(process.env.BMN_CONTROL_SOCKET || process.env.AITERM_CONTROL_SOCKET)) return
    // The root session this terminal shows; BMN treats every other session of its family as a subagent's.
    let pinned: string | undefined
    const parents = new Map<string, string>()
    // Top-level sessions created while this terminal ran: the first visit to one starts a conversation, not a resume.
    const created = new Set<string>()
    // Sessions this terminal has shown: coming back to one resumes it.
    const attached = new Set<string>()
    // Each open question's fields, to turn a tap's labels into OpenCode's values and its values back into labels.
    const forms = new Map<string, Field[]>()
    // The owner's own session's questions and permissions still waiting, by request, with their session.
    const waiting = new Map<string, string>()
    // Its permissions among them: a Deny goes out only while it answers the one permission waiting.
    const waitingPermissions = new Set<string>()
    // What OpenCode said to each reply, told to BMN on the next collection.
    const reports: string[] = []
    let polling = false
    let stopped = false
    let queue: Promise<unknown> = Promise.resolve()

    const rootOf = (id: string) => {
      try {
        const known = context.data.session.root(id)
        if (typeof known === "string" && known !== "" && known !== id) return known
      } catch {
        // A session the terminal has not loaded falls back to the parents this plugin heard of.
      }
      let root = id
      for (let hops = 0; parents.has(root) && hops < 64; hops += 1) root = parents.get(root) as string
      return root
    }

    // Tells BMN one event, in order, in the shape bmn hook opencode reads.
    const hook = (name: string, payload: Record<string, unknown>) => {
      const body = JSON.stringify({ hook_event_name: name, ...payload })
      const env = { ...process.env, BMN_OPENCODE_SESSION_ID: pinned ?? "" }
      queue = queue.then(() => run(["-s", "KILL", "3s", "bmn", "hook", "opencode"], env, body)).catch(() => undefined)
    }

    const forget = () => {
      waiting.clear()
      waitingPermissions.clear()
    }

    // Follows the session on screen; moving to another one is OpenCode 1's tui.session.select, after which BMN
    // withdraws the last one's requests from the phone. The home screen keeps the last session: its turn and
    // requests still reach BMN until the owner opens another one.
    const follow = () => {
      let route: any
      try {
        route = context.ui.router.current()
      } catch {
        return
      }
      if (route?.type !== "session" || typeof route.sessionID !== "string") return
      const root = rootOf(route.sessionID)
      if (root === pinned) return
      pinned = root
      forget()
      let fresh = false
      if (!attached.has(root)) {
        attached.add(root)
        fresh = created.has(root)
        try {
          const started = context.data.session.get(root)?.time?.created
          if (typeof started === "number" && Date.now() - started < 30000) fresh = true
        } catch {
          // Unknown to the terminal: only a session.created this plugin heard makes it new.
        }
      }
      if (fresh) hook("session.created", { sessionID: root, info: { id: root } })
      else hook("tui.session.select", { sessionID: root })
    }

    // A tap's labels as the form's answer, or undefined when they do not fit its fields.
    const formAnswer = (fields: Field[], answers: unknown) => {
      if (!Array.isArray(answers) || answers.length !== fields.length) return undefined
      const answer: Record<string, unknown> = {}
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index]
        const labels = answers[index]
        if (!Array.isArray(labels) || labels.length === 0 || labels.some((label) => typeof label !== "string")) return undefined
        if (field.type !== "multiselect" && labels.length !== 1) return undefined
        const values: unknown[] = []
        for (const label of labels) {
          const option = (field.options ?? []).find((candidate) => candidate.label === label)
          // Typed text goes only where the question takes it.
          if (option === undefined && field.custom === false) return undefined
          values.push(option === undefined ? label : option.value)
        }
        answer[field.key] = field.type === "multiselect" ? values : values[0]
      }
      return answer
    }

    // A form's answer as the labels the owner saw, one list per question.
    const labelsOf = (fields: Field[] | undefined, answer: any) => {
      if (fields === undefined || answer === null || typeof answer !== "object") return undefined
      return fields.map((field) => {
        const value = answer[field.key]
        const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
        return values.map((item) => (field.options ?? []).find((option) => option.value === item)?.label ?? String(item))
      })
    }

    // Only an accepted reply or a refused one is reported; any other failure may still have applied it.
    const settle = async (ref: string, request: Promise<unknown>) => {
      try {
        await request
        reports.push(ref + "=ok")
      } catch (error) {
        if (refused(error)) reports.push(ref + "=failed")
      }
    }

    // An answer BMN already decided from a tap, sent to OpenCode by this terminal's own client.
    const reply = async (answer: Answer) => {
      const ref = answer.requestRef
      // The terminal may have moved since the answer was collected, with no event yet to say so: look now.
      follow()
      if (stopped || typeof ref !== "string" || !waiting.has(ref)) return
      const sessionID = waiting.get(ref) as string
      if (answer.kind === "question") {
        const fields = forms.get(ref)
        const result = fields === undefined ? undefined : formAnswer(fields, answer.answers)
        if (result === undefined) return
        await settle(ref, context.client.session.form.reply({ sessionID, formID: ref, answer: result }))
        return
      }
      const reject = answer.reply === "reject"
      if (reject && (waitingPermissions.size !== 1 || !waitingPermissions.has(ref))) return
      await settle(ref, context.client.permission.reply({ sessionID, requestID: ref, decision: reject ? "reject" : "once" }))
    }

    // Asks BMN only while something waits, and gives up after three failures so an absent BMN costs nothing.
    const poll = async () => {
      if (polling) return
      polling = true
      let failures = 0
      try {
        while (!stopped && (waiting.size > 0 || reports.length > 0) && failures < 3) {
          const report = reports.shift()
          const result = report
            ? await run(["-s", "KILL", "10s", "bmn", "answer", "take", "--wait", "0", "--reported", report, "--json"], process.env)
            : await run(["-s", "KILL", "35s", "bmn", "answer", "take", "--wait", "25", "--json"], process.env)
          if (result.code !== 0) {
            if (report) reports.unshift(report)
            failures += 1
            await new Promise((resolve) => setTimeout(resolve, 5000))
            continue
          }
          failures = 0
          const parsed = JSON.parse(result.stdout) as { answers?: unknown[] }
          for (const answer of parsed.answers ?? []) await reply(answer as Answer).catch(() => undefined)
        }
      } catch {
        // A malformed answer leaves the dialog for the owner at the terminal.
      } finally {
        polling = false
      }
    }

    const wait = (ref: unknown, sessionID: string, permission: boolean) => {
      if (typeof ref !== "string" || sessionID !== pinned) return
      waiting.set(ref, sessionID)
      if (permission) waitingPermissions.add(ref)
      void poll()
    }

    const done = (ref: unknown) => {
      if (typeof ref !== "string") return
      waiting.delete(ref)
      waitingPermissions.delete(ref)
    }

    // The models each session last named, so a new one is told once.
    const models = new Map<string, string>()

    const handle = (event: any) => {
      const type = String(event?.type ?? "")
      const data = event?.data ?? {}
      if (type === "session.created" && typeof data.sessionID === "string") {
        if (typeof data.parentID === "string") parents.set(data.sessionID, data.parentID)
        else created.add(data.sessionID)
      }
      follow()
      const id = typeof data.sessionID === "string" ? data.sessionID : data.form?.sessionID
      if (pinned === undefined || typeof id !== "string" || rootOf(id) !== pinned) return
      switch (type) {
        case "permission.asked": {
          const resources = Array.isArray(data.resources) ? data.resources : []
          const save = Array.isArray(data.save) && data.save.length > 0 ? data.save : resources
          hook(type, {
            id: data.id, sessionID: id, permission: data.action, patterns: save,
            // Only a shell request names exactly what would run.
            metadata: { command: data.action === "shell" && resources.length === 1 ? resources[0] : undefined }
          })
          wait(data.id, id, true)
          return
        }
        case "permission.replied":
          hook(type, { sessionID: id, requestID: data.requestID, reply: data.reply })
          done(data.requestID)
          return
        case "form.created": {
          const form = data.form
          if (form?.metadata?.kind !== "question" || typeof form.id !== "string" || !Array.isArray(form.fields)) return
          forms.set(form.id, form.fields)
          hook("question.asked", {
            id: form.id, sessionID: id,
            questions: form.fields.map((field: any) => ({
              question: field.description ?? field.title, header: field.title,
              options: (field.options ?? []).map((option: any) => ({ label: option.label, description: option.description })),
              multiple: field.type === "multiselect",
              ...(typeof field.custom === "boolean" ? { custom: field.custom } : {})
            }))
          })
          wait(form.id, id, false)
          return
        }
        case "form.replied":
          if (!forms.has(data.id)) return
          hook("question.replied", { sessionID: id, requestID: data.id, answers: labelsOf(forms.get(data.id), data.answer) })
          forms.delete(data.id)
          done(data.id)
          return
        case "form.cancelled":
          if (!forms.has(data.id)) return
          hook("question.rejected", { sessionID: id, requestID: data.id })
          forms.delete(data.id)
          done(data.id)
          return
        case "session.execution.started":
          hook("session.status", { sessionID: id, status: { type: "busy" } })
          return
        case "session.execution.interrupted":
          // Only the owner's own stop ends a turn; a superseded, idle or shut-down run is not a finished turn.
          if (data.reason !== "user") return
        // falls through
        case "session.execution.succeeded":
          hook("session.idle", { sessionID: id })
          if (id === pinned) forget()
          return
        case "session.execution.failed":
          hook("session.error", { sessionID: id, error: data.error })
          return
        case "session.step.started": {
          const model = data.model?.id
          if (typeof model !== "string" || models.get(id) === model) return
          models.set(id, model)
          hook("message.updated", { sessionID: id, info: { sessionID: id, role: "assistant", modelID: model, providerID: data.model?.providerID } })
          return
        }
        case "session.compaction.ended":
          hook("session.compacted", { sessionID: id })
          return
        case "session.deleted":
          hook(type, { sessionID: id })
          return
        default:
      }
    }

    const stop = context.data.listen((input: any) => {
      try {
        handle(input?.details ?? input)
      } catch {
        // A payload this plugin does not understand must never interrupt OpenCode.
      }
    })
    const timer = setInterval(() => {
      try {
        follow()
      } catch {
        // As above.
      }
    }, 1000)
    timer.unref?.()
    return () => {
      stopped = true
      clearInterval(timer)
      stop?.()
    }
  },
}
`
