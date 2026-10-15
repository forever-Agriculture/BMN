#!/bin/sh
# MODULE: ask-git.sh - Epic 72: the `git` a teammate's project ask runs inside its container: only log, show, diff and blame, only options that read the frozen repository, never one that writes a file or reads one outside it
#
# A project ask's teammate reads the project's history with git log, show, diff and blame (R72-NFR2). Its
# app lets only command lines that start with those words run, but git itself takes options that write a file
# (--output), read any file the container shows (diff --no-index, blame --contents, -O, --pathspec-from-file,
# --ignore-revs-file) or run a program (external diff, textconv), and it takes any unique beginning of a long
# option as the option (--cont= is --contents=). This file stands first on the run's PATH as `git`: it takes the
# subcommand from an allowlist and every option only when it is spelled whole as one of the read-only options
# below, refusing anything else by name, and runs the system's git with no configuration but the frozen
# repository's own, which BMN writes.

refuse() {
  printf 'git (BMN ask): %s is not allowed in a read-only project ask\n' "$1" >&2
  exit 128
}

[ "$#" -ge 1 ] || refuse 'git without a subcommand'
command=$1
shift
case $command in
  log|show|diff|blame) ;;
  *) refuse "git $command" ;;
esac

after_dashes=0
for argument in "$@"; do
  if [ "$after_dashes" -eq 1 ]; then
    # A path: inside the repository only; git refuses one outside it, and none may climb out by name.
    case $argument in
      /*|../*|*/../*|..) refuse "the path $argument" ;;
    esac
    continue
  fi
  case $argument in
    --) after_dashes=1 ;;
    # Whole spellings only, each read-only: what to show, how to walk the history, how to compare.
    --oneline|--stat|--stat=*|--shortstat|--numstat|--dirstat|--dirstat=*|--name-only|--name-status|--summary|--raw|--patch|--no-patch|\
    --patch-with-stat|--patch-with-raw|--compact-summary|--format=*|--pretty|--pretty=*|--abbrev-commit|--no-abbrev-commit|--abbrev|--abbrev=*|\
    --decorate|--decorate=short|--decorate=full|--decorate=no|--no-decorate|--graph|--date=*|--relative-date|--follow|--no-merges|--merges|\
    --first-parent|--reverse|--topo-order|--date-order|--author-date-order|--full-history|--simplify-by-decoration|--ancestry-path|--all|\
    --max-count=*|--skip=*|--since=*|--after=*|--until=*|--before=*|--author=*|--committer=*|--grep=*|--all-match|--invert-grep|\
    --regexp-ignore-case|--extended-regexp|--fixed-strings|--perl-regexp|--basic-regexp|--pickaxe-all|--pickaxe-regex|--diff-filter=*|\
    --find-renames|--find-renames=*|--find-copies|--find-copies=*|--find-copies-harder|--no-renames|--unified=*|--function-context|\
    --ignore-all-space|--ignore-space-change|--ignore-blank-lines|--ignore-space-at-eol|--ignore-cr-at-eol|--word-diff|--word-diff=plain|\
    --word-diff=porcelain|--word-diff=none|--color-words|--no-color|--color=never|--minimal|--patience|--histogram|--diff-algorithm=*|\
    --cached|--staged|--merge-base|--exit-code|--quiet|--full-index|--relative|--relative=*|--no-relative|--text|--parents|--children|\
    --left-right|--boundary|--source|--cherry-pick|--cherry-mark|--cherry|--no-walk|--no-walk=*|--do-walk|--cc|--remerge-diff|--dd|\
    --diff-merges=*|--no-diff-merges|--porcelain|--line-porcelain|--incremental|--root|--show-email|--show-name|--show-number|--show-stats|\
    --score-debug|--src-prefix=*|--dst-prefix=*|--no-prefix|--default-prefix|--submodule=short|--submodule=log|--no-ext-diff|--no-textconv|\
    -p|-s|-u|-w|-b|-R|-z|-a|-i|-E|-F|-P|-m|-e|-f|-l|-t|-n|-D|-[0-9]|-[0-9][0-9]|-[0-9][0-9][0-9]|-[0-9][0-9][0-9][0-9]) ;;
    # A short option with its value joined to it or after it: a count, a context, a range or a search string.
    -n[0-9]*|-U[0-9]*|-M|-M[0-9]*|-C|-C[0-9]*|-B|-B[0-9]*|-L|-L?*|-G|-G?*) ;;
    -S|-S?*)
      # In blame -S names a file to read; in log and diff it is a search string.
      [ "$command" = blame ] && refuse "the option $argument" ;;
    -*) refuse "the option $argument (only whole, read-only options are taken)" ;;
    *:*)
      # A revision with a path (HEAD:src/app.js): the path stays inside the repository.
      path=${argument#*:}
      case $path in
        /*|../*|*/../*|..) refuse "the path $argument" ;;
      esac ;;
    /*|../*|*/../*|..) refuse "the path $argument" ;;
  esac
done

GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_PAGER=cat
PAGER=cat
GIT_OPTIONAL_LOCKS=0
GIT_NO_REPLACE_OBJECTS=1
GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_PAGER PAGER GIT_OPTIONAL_LOCKS GIT_NO_REPLACE_OBJECTS GIT_TERMINAL_PROMPT
unset GIT_DIR GIT_WORK_TREE GIT_EXTERNAL_DIFF GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_EXEC_PATH
exec /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat -c log.showSignature=false -c gpg.program=/bin/false \
  --no-pager "$command" --no-ext-diff --no-textconv "$@"
