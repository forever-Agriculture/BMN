/* MODULE: defaults-publication-syscall-race.c - Test-only independent writers at the real helper's renameat2 boundary */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

long __real_syscall(long number, ...);

static int writer(int directory, const char *source, int occupied) {
  pid_t child = fork();
  if (child < 0) return -1;
  if (child == 0) {
    const char *name = occupied || TEST_IN_PLACE ? source : ".independent-native-replacement";
    const char *text = occupied ? "new original-name occupant" : "independent native replacement";
    int fd = openat(directory, name, O_WRONLY | O_NOFOLLOW | (!occupied && TEST_IN_PLACE ? O_TRUNC : O_CREAT | O_EXCL), 0600);
    if (fd < 0 || write(fd, text, strlen(text)) != (ssize_t)strlen(text) || close(fd)) _exit(1);
    if (!occupied && !TEST_IN_PLACE && renameat(directory, name, directory, source)) _exit(2);
    _exit(0);
  }
  int status;
  return waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
}

long __wrap_syscall(long number, ...) {
  if (number != SYS_renameat2) { errno = ENOSYS; return -1; }
  va_list args;
  va_start(args, number);
  int source_directory = va_arg(args, int);
  const char *source = va_arg(args, const char *);
  int target_directory = va_arg(args, int);
  const char *target = va_arg(args, const char *);
  int flags = va_arg(args, int);
  va_end(args);
  /* The production helper has already checked the old inode. The child now replaces its name. */
  if (writer(source_directory, source, 0)) { errno = EIO; return -1; }
  long result = __real_syscall(number, source_directory, source, target_directory, target, flags);
#if TEST_OCCUPIED
  if (result == 0 && writer(source_directory, source, 1)) { errno = EIO; return -1; }
#endif
  return result;
}
