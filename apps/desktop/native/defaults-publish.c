/* MODULE: defaults-publish.c - Linux no-replace publication through an inherited pinned directory */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int result(int published, const char *code, int number) {
  printf("{\"version\":1,\"published\":%s,\"code\":\"%s\",\"errno\":%d}\n", published ? "true" : "false", code, number);
  return strcmp(code, "OK") == 0 ? 0 : 1;
}
static int name_ok(const char *name) {
  return name[0] && !strchr(name, '/') && strcmp(name, ".") && strcmp(name, "..");
}
static int number(const char *text, uint64_t *value) {
  if (!text[0]) return 0;
  for (const char *c = text; *c; c++) if (*c < '0' || *c > '9') return 0;
  errno = 0;
  char *end;
  unsigned long long parsed = strtoull(text, &end, 10);
  if (errno || *end) return 0;
  *value = (uint64_t)parsed;
  return 1;
}
int main(int argc, char **argv) {
  uint64_t source_dev, source_ino, parent_dev, parent_ino;
  if (argc != 8 || !name_ok(argv[1]) || !name_ok(argv[2]) ||
      (strcmp(argv[3], "tree") && strcmp(argv[3], "link") && strcmp(argv[3], "file")) ||
      !number(argv[4], &source_dev) || !number(argv[5], &source_ino) ||
      !number(argv[6], &parent_dev) || !number(argv[7], &parent_ino)) return result(0, "ARGUMENT", 0);
  struct stat parent, source, target;
  if (fstat(3, &parent) || !S_ISDIR(parent.st_mode) || (uint64_t)parent.st_dev != parent_dev ||
      (uint64_t)parent.st_ino != parent_ino) return result(0, "PARENT_CHANGED", errno);
  if (fstatat(3, argv[1], &source, AT_SYMLINK_NOFOLLOW) || (uint64_t)source.st_dev != source_dev ||
      (uint64_t)source.st_ino != source_ino ||
      (strcmp(argv[3], "tree") == 0 ? !S_ISDIR(source.st_mode) :
       strcmp(argv[3], "file") == 0 ? !S_ISREG(source.st_mode) : !S_ISLNK(source.st_mode))) return result(0, "SOURCE_CHANGED", errno);
  /* Never emulate this with ordinary rename or copy/delete on an unsupported filesystem. */
  if (syscall(SYS_renameat2, 3, argv[1], 3, argv[2], RENAME_NOREPLACE)) {
    int failure = errno;
    return result(0, failure == EEXIST || failure == ENOTEMPTY ? "EXISTS" :
      failure == ENOSYS || failure == EINVAL || failure == EOPNOTSUPP ? "UNSUPPORTED" : "IO_ERROR", failure);
  }
  if (fsync(3)) return result(1, "SYNC_FAILED", errno);
  if (fstatat(3, argv[2], &target, AT_SYMLINK_NOFOLLOW) || (uint64_t)target.st_dev != source_dev ||
      (uint64_t)target.st_ino != source_ino) return result(1, "TARGET_CHANGED", errno);
  return result(1, "OK", 0);
}
