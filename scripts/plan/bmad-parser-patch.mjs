// MODULE: bmad-parser-patch.mjs - exact-version D10 compatibility for repository-local BMAD parsers
import { createHash } from 'node:crypto'

export const BMAD_ORIGINAL_SHA = '4c30f62c261599fc1da3fd319ea6ce5092aa0332221cedee1763a1040627e6bc'
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Only the measured version is supported. Never infer a patch from a similar-looking parser. */
export function compatibleParser(bytes) {
  if (digest(bytes) !== BMAD_ORIGINAL_SHA) throw new Error('BMAD_VERSION_UNSUPPORTED: repository parser differs from the rehearsed version')
  let text = bytes.toString()
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw new Error('BMAD_PATCH_MISMATCH: expected exactly one parser boundary')
    text = text.replace(before, after)
  }
  replace('RETRO_RANK = {"optional": 0, "done": 1}', `# BMN D10: held rows are legal but never runnable or implicitly resumed.
RESERVED_STATUSES = frozenset(("blocked", "deferred", "withdrawn"))
STORY_RANK.update({status: 0 for status in RESERVED_STATUSES})
EPIC_RANK.update({"ready-for-dev": 0, "review": 1, **{status: 0 for status in RESERVED_STATUSES}})
RETRO_RANK = {"optional": 0, "done": 1}`)
  replace('    return existing if rank[existing] >= rank[computed] else computed', `    if existing in RESERVED_STATUSES:
        return existing
    return existing if rank[existing] >= rank[computed] else computed`)
  replace('    computed_keys = {key for key, _, _ in entries}', `    # A renamed or omitted definition must not resurrect a held row later.
    for key, raw in existing_status.items():
        if key not in dev and classify_key(str(key)) and _normalize(raw)[0] in RESERVED_STATUSES:
            dev[key] = _normalize(raw)[0]
    computed_keys = set(dev)`)
  replace('    merge_source = None if args.fresh else existing', `    # Fresh rebuilds require an explicit repair for every held row, including
    # omitted definitions. An unconfirmed fresh rebuild leaves all bytes intact.
    if args.fresh and existing is not None:
        explicit_keys = {key for key, _ in _parse_sets(args.set or [], {key for key, _, _ in entries})}
        held = [str(key) for key, raw in (existing.get("development_status") or {}).items()
                if classify_key(str(key)) and _normalize(raw)[0] in RESERVED_STATUSES and str(key) not in explicit_keys]
        if held:
            _fail("BMN_HELD_ROWS: --fresh requires explicit --set for every held row", held=held)
    merge_source = None if args.fresh else existing`)
  replace('    recommendation = None\n    if by_status.get("in-progress"):', `    held_epics = {num for num, status in epic_status.items() if status in RESERVED_STATUSES}
    held_story_epics = {classify_key(key)[1] for status, keys in by_status.items()
                        if status in ("blocked", "deferred") for key in keys}
    unfinished_held = bool(held_story_epics or any(status in ("blocked", "deferred") for status in epic_status.values()))
    for status in by_status:
        by_status[status] = [key for key in by_status[status] if classify_key(key)[1] not in held_epics]
    if unfinished_held:
        risks.append("held work remains; no implicit resume or completion")

    recommendation = None
    if by_status.get("in-progress"):`)
  replace('        optional_retros = sorted(num for num, status in retro_status.items() if status == "optional")', `        optional_retros = sorted(num for num, status in retro_status.items()
                                 if status == "optional" and num not in held_epics and num not in held_story_epics)`)
  replace('"reason": f"all stories done — epic-{optional_retros[0]}-retrospective is still open"}', `"reason": f"epic-{optional_retros[0]}-retrospective is still open"}`)
  replace('        "all_done": recommendation is None,', '        "all_done": recommendation is None and not unfinished_held and not illegal and not unrecognized,')
  return Buffer.from(text)
}
