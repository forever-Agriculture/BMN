// MODULE: bmn-launcher.c - Windows `bmn` command: runs the bmn CLI script on BMN's own runtime
//
// Story 53.4. Sessions find bmn.exe on PATH. It forwards its own command-line tail to
// the runtime byte for byte, so the CLI's argv is exactly what this program's C runtime
// would have parsed: no shell, batch file or re-quoting sits in between. The child
// inherits the console, standard handles and job; this process ignores Ctrl+C and
// returns the child's exit code once it exits.
//
// Layout: a packaged build runs <exe dir>\..\..\BMN.exe with <exe dir>\bmn.mjs. A
// development build places bmn.runtime next to this program: two UTF-8 lines naming
// the runtime and the script by absolute path.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define MAX_LONG_PATH 32768

static int fail(const wchar_t* what, DWORD code) {
  fwprintf(stderr, L"bmn: %ls (Windows error %lu)\n", what, (unsigned long)code);
  return 127;
}

static wchar_t* readLine(char** cursor) {
  char* start = *cursor;
  char* end = start;
  while (*end && *end != '\r' && *end != '\n') end++;
  char* next = end;
  while (*next == '\r' || *next == '\n') next++;
  *cursor = next;
  int length = (int)(end - start);
  if (length <= 0) return NULL;
  int wide = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, start, length, NULL, 0);
  if (wide <= 0 || wide >= MAX_LONG_PATH) return NULL;
  wchar_t* text = (wchar_t*)calloc((size_t)wide + 1, sizeof(wchar_t));
  if (!text) return NULL;
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, start, length, text, wide);
  return text;
}

// Development sidecar; absent in packaged builds.
static BOOL readSidecar(const wchar_t* directory, wchar_t** runtime, wchar_t** script) {
  wchar_t path[MAX_LONG_PATH];
  if (swprintf(path, MAX_LONG_PATH, L"%ls\\bmn.runtime", directory) < 0) return FALSE;
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  char buffer[4 * MAX_LONG_PATH + 1];
  DWORD read = 0;
  BOOL ok = ReadFile(file, buffer, sizeof(buffer) - 1, &read, NULL);
  CloseHandle(file);
  if (!ok) return FALSE;
  buffer[read] = 0;
  char* cursor = buffer;
  *runtime = readLine(&cursor);
  *script = readLine(&cursor);
  return *runtime && *script;
}

// The tail after argv[0], split by the rule CreateProcess and the C runtime use for the
// program name: a quoted name ends at the next quote, otherwise at the first space or tab.
static const wchar_t* commandTail(const wchar_t* line) {
  if (*line == L'"') {
    line++;
    while (*line && *line != L'"') line++;
    if (*line == L'"') line++;
  } else {
    while (*line && *line != L' ' && *line != L'\t') line++;
  }
  while (*line == L' ' || *line == L'\t') line++;
  return line;
}

static BOOL WINAPI waitForChild(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int wmain(void) {
  wchar_t self[MAX_LONG_PATH];
  DWORD length = GetModuleFileNameW(NULL, self, MAX_LONG_PATH);
  if (length == 0 || length >= MAX_LONG_PATH) return fail(L"cannot locate bmn.exe", GetLastError());
  wchar_t* slash = wcsrchr(self, L'\\');
  if (!slash) return fail(L"cannot locate bmn.exe", ERROR_BAD_PATHNAME);
  *slash = 0;

  wchar_t* runtime = NULL;
  wchar_t* script = NULL;
  wchar_t packagedRuntime[MAX_LONG_PATH];
  wchar_t packagedScript[MAX_LONG_PATH];
  if (!readSidecar(self, &runtime, &script)) {
    wchar_t candidate[MAX_LONG_PATH];
    if (swprintf(candidate, MAX_LONG_PATH, L"%ls\\..\\..\\BMN.exe", self) < 0 ||
        !GetFullPathNameW(candidate, MAX_LONG_PATH, packagedRuntime, NULL) ||
        swprintf(packagedScript, MAX_LONG_PATH, L"%ls\\bmn.mjs", self) < 0) {
      return fail(L"cannot locate the BMN runtime", ERROR_BAD_PATHNAME);
    }
    runtime = packagedRuntime;
    script = packagedScript;
  }
  if (GetFileAttributesW(runtime) == INVALID_FILE_ATTRIBUTES) return fail(L"the BMN runtime is missing", GetLastError());
  if (GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) return fail(L"the bmn CLI script is missing", GetLastError());

  const wchar_t* tail = commandTail(GetCommandLineW());
  size_t size = wcslen(runtime) + wcslen(script) + wcslen(tail) + 8;
  if (size > MAX_LONG_PATH) return fail(L"the command line is too long", ERROR_FILENAME_EXCED_RANGE);
  wchar_t* commandLine = (wchar_t*)calloc(size, sizeof(wchar_t));
  if (!commandLine) return fail(L"out of memory", ERROR_OUTOFMEMORY);
  // Windows paths cannot contain quotes, so quoting the two paths is exact.
  swprintf(commandLine, size, *tail ? L"\"%ls\" \"%ls\" %ls" : L"\"%ls\" \"%ls\"", runtime, script, tail);

  // Only the child runs as Node; nothing else in the inherited environment changes.
  if (!SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1")) return fail(L"cannot prepare the runtime", GetLastError());
  // Ctrl+C reaches the child through the shared console; this process waits for it. A handler
  // routine, unlike SetConsoleCtrlHandler(NULL, TRUE), is not inherited by the child.
  SetConsoleCtrlHandler(waitForChild, TRUE);

  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION child;
  ZeroMemory(&child, sizeof(child));
  if (!CreateProcessW(runtime, commandLine, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) {
    return fail(L"cannot start the BMN runtime", GetLastError());
  }
  CloseHandle(child.hThread);
  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD exitCode = 1;
  if (!GetExitCodeProcess(child.hProcess, &exitCode)) exitCode = 1;
  CloseHandle(child.hProcess);
  return (int)exitCode;
}
