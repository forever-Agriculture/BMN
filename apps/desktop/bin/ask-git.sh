#!/bin/sh
# MODULE: ask-git.sh - Epic 72: the `git` a teammate's project ask runs inside its container: only log, show, diff and blame, only options that read the frozen repository, never one that writes a file or reads one outside it
#
# A project ask's teammate reads the project's history with git log, show, diff and blame (R72-NFR2). Its
# app lets only command lines that start with those words run, but git itself takes options that write a file
# (--output), read any file the container shows (diff --no-index, blame --contents, -O, --pathspec-from-file,
# --ignore-revs-file) or run a program (external diff, textconv). This file stands first on the run's PATH as
# `git`: it takes the subcommand and every option from an allowlist, refuses anything else by name, and runs
# the system's git with no configuration but the frozen repository's own, which BMN writes.

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
    --output|--output=*|--no-index|--contents|--contents=*|-O*|--orderfile|--orderfile=*|--pathspec-from-file|--pathspec-from-file=*|\
    --ignore-revs-file|--ignore-revs-file=*|--ext-diff|--textconv|--exec-path|--exec-path=*|--git-dir|--git-dir=*|--work-tree|--work-tree=*|\
    --namespace|--namespace=*|--super-prefix|--super-prefix=*|-c|--config-env|--config-env=*|--stdin|--use-mailmap|--mailmap*|--notes*|--show-notes*)
      refuse "the option $argument" ;;
    -S*)
      # In blame -S names a file to read; in log and diff it is a search string.
      [ "$command" = blame ] && refuse "the option $argument" ;;
    -*) ;;
    *:*)
      # A revision with a path (HEAD:src/app.js): the path stays inside the repository.
      path=${argument#*:}
      case $path in
        /*|../*|*/../*|..) refuse "the path $argument" ;;
      esac ;;
    /*) refuse "the path $argument" ;;
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
