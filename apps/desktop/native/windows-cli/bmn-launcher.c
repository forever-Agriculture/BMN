// MODULE: bmn-launcher.c - Windows `bmn` command: runs the bmn CLI script on BMN's own runtime
//
// Story 53.4. Sessions find bmn.exe on PATH. It forwards its own command-line tail to
// the runtime byte for byte, so the CLI's argv is exactly what this program's C runtime
// would have parsed: no shell, batch file or re-quoting sits in between. The child
// inherits the console and standard handles inside a launcher-owned nested job.
// This process ignores Ctrl+C, confirms cleanup, and returns the child's exit code.
// Killing/crashing the launcher closes its sole job handle and ends its runtime tree.
//
// Layout: a packaged build runs <exe dir>\..\..\BMN.exe with <exe dir>\<name>.mjs, where
// <name> is this program's own file name (bmn for bmn.exe). A development build places
// <name>.runtime next to this program: two UTF-8 lines naming the runtime and the script
// by absolute path.
//
// Built with BMN_LAUNCHER_SHARED_TREE (codex.exe), the runtime stays in the caller's own
// job instead of a nested one, as the Linux wrapper's exec does: a daemon the command
// starts outlives it. The runtime learns this launcher's folder from
// BMN_LAUNCHER_DIRECTORY, so its own lookup can skip it.
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#define MAX_LONG_PATH 32768

static wchar_t program[MAX_PATH] = L"bmn";

static int fail(const wchar_t* what, DWORD code) {
  fwprintf(stderr, L"%ls: %ls (Windows error %lu)\n", program, what, (unsigned long)code);
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
  if (swprintf(path, MAX_LONG_PATH, L"%ls\\%ls.runtime", directory, program) < 0) return FALSE;
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

#ifndef BMN_LAUNCHER_SHARED_TREE
// Query job membership rather than signaling reusable PIDs. Closing the sole handle
// remains the fallback if termination or confirmation fails.
static BOOL endRuntimeTree(HANDLE job, DWORD exitCode) {
  if (!TerminateJobObject(job, exitCode)) return FALSE;
  ULONGLONG deadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    ZeroMemory(&accounting, sizeof(accounting));
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) return FALSE;
    if (accounting.ActiveProcesses == 0) return TRUE;
    if (GetTickCount64() >= deadline) { SetLastError(ERROR_TIMEOUT); return FALSE; }
    Sleep(10);
  }
}
#endif

// Compiled only by the disposable native ownership gate. Production builds expose
// no environment-controlled pause. The observer retains the suspended/resumed
// runtime handle before killing this launcher at the requested creation boundary.
#ifdef BMN_CLI_OWNERSHIP_TEST
static BOOL testCreationGate(const wchar_t* boundary, DWORD pid) {
  wchar_t selected[32], record[MAX_LONG_PATH], partial[MAX_LONG_PATH];
  DWORD size = GetEnvironmentVariableW(L"BMN_CLI_TEST_BOUNDARY", selected, 32);
  if (!size || size >= 32 || wcscmp(selected, boundary)) return TRUE;
  size = GetEnvironmentVariableW(L"BMN_CLI_TEST_RECORD", record, MAX_LONG_PATH);
  if (!size || size >= MAX_LONG_PATH) return FALSE;
  if (swprintf(partial, MAX_LONG_PATH, L"%ls.tmp", record) < 0) return FALSE;
  HANDLE file = CreateFileW(partial, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  char text[32]; int length = snprintf(text, sizeof(text), "%lu", (unsigned long)pid);
  DWORD written = 0;
  BOOL ok = length > 0 && WriteFile(file, text, (DWORD)length, &written, NULL) && written == (DWORD)length;
  CloseHandle(file);
  if (!ok || !MoveFileExW(partial, record, MOVEFILE_WRITE_THROUGH)) return FALSE;
  Sleep(10000); // External observer must terminate the launcher before this expires.
  SetLastError(ERROR_TIMEOUT); return FALSE;
}
#endif

int wmain(void) {
  wchar_t self[MAX_LONG_PATH];
  DWORD length = GetModuleFileNameW(NULL, self, MAX_LONG_PATH);
  if (length == 0 || length >= MAX_LONG_PATH) return fail(L"cannot locate this program", GetLastError());
  wchar_t* slash = wcsrchr(self, L'\\');
  if (!slash) return fail(L"cannot locate this program", ERROR_BAD_PATHNAME);
  *slash = 0;
  // The program's own name, without .exe, names its script and sidecar.
  const wchar_t* name = slash + 1;
  size_t nameLength = wcslen(name);
  if (nameLength > 4 && _wcsicmp(name + nameLength - 4, L".exe") == 0) nameLength -= 4;
  if (nameLength == 0 || nameLength >= MAX_PATH) return fail(L"cannot name this program", ERROR_BAD_PATHNAME);
  wcsncpy_s(program, MAX_PATH, name, nameLength);

  wchar_t* runtime = NULL;
  wchar_t* script = NULL;
  wchar_t packagedRuntime[MAX_LONG_PATH];
  wchar_t packagedScript[MAX_LONG_PATH];
  if (!readSidecar(self, &runtime, &script)) {
    wchar_t candidate[MAX_LONG_PATH];
    if (swprintf(candidate, MAX_LONG_PATH, L"%ls\\..\\..\\BMN.exe", self) < 0 ||
        !GetFullPathNameW(candidate, MAX_LONG_PATH, packagedRuntime, NULL) ||
        swprintf(packagedScript, MAX_LONG_PATH, L"%ls\\%ls.mjs", self, program) < 0) {
      return fail(L"cannot locate the BMN runtime", ERROR_BAD_PATHNAME);
    }
    runtime = packagedRuntime;
    script = packagedScript;
  }
  if (GetFileAttributesW(runtime) == INVALID_FILE_ATTRIBUTES) return fail(L"the BMN runtime is missing", GetLastError());
  if (GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
    DWORD error = GetLastError();
    wchar_t what[MAX_PATH + 32];
    swprintf(what, MAX_PATH + 32, L"the %ls CLI script is missing", program);
    return fail(what, error);
  }

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

#ifdef BMN_LAUNCHER_SHARED_TREE
  if (!SetEnvironmentVariableW(L"BMN_LAUNCHER_DIRECTORY", self)) return fail(L"cannot prepare the runtime", GetLastError());
  STARTUPINFOW shared;
  ZeroMemory(&shared, sizeof(shared));
  shared.cb = sizeof(shared);
  shared.dwFlags = STARTF_USESTDHANDLES;
  shared.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  shared.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  shared.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION runtimeProcess;
  ZeroMemory(&runtimeProcess, sizeof(runtimeProcess));
  if (!CreateProcessW(runtime, commandLine, NULL, NULL, TRUE, 0, NULL, NULL, &shared, &runtimeProcess)) {
    DWORD error = GetLastError(); free(commandLine);
    return fail(L"cannot start the BMN runtime", error);
  }
  CloseHandle(runtimeProcess.hThread);
  DWORD sharedWait = WaitForSingleObject(runtimeProcess.hProcess, INFINITE);
  DWORD sharedExit = 1;
  BOOL sharedExited = sharedWait == WAIT_OBJECT_0 && GetExitCodeProcess(runtimeProcess.hProcess, &sharedExit);
  DWORD sharedError = GetLastError();
  CloseHandle(runtimeProcess.hProcess);
  free(commandLine);
  if (!sharedExited) return fail(L"cannot confirm runtime exit", sharedError);
  return (int)sharedExit;
#else
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) return fail(L"cannot own the BMN runtime", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetHandleInformation(job, HANDLE_FLAG_INHERIT, 0) ||
      !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    DWORD error = GetLastError(); CloseHandle(job);
    return fail(L"cannot protect runtime ownership", error);
  }
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attributeBytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attributeBytes);
  if (!attributes) { CloseHandle(job); return fail(L"out of memory", ERROR_OUTOFMEMORY); }
  if (!InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes)) {
    DWORD error = GetLastError(); HeapFree(GetProcessHeap(), 0, attributes); CloseHandle(job);
    return fail(L"cannot initialize runtime ownership", error);
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL)) {
    DWORD error = GetLastError(); DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes); CloseHandle(job);
    return fail(L"cannot set atomic runtime ownership", error);
  }
  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION child;
  ZeroMemory(&child, sizeof(child));
  BOOL created = CreateProcessW(runtime, commandLine, NULL, NULL, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, NULL, NULL, &startup.StartupInfo, &child);
  DWORD launchError = GetLastError();
  DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes);
  if (!created) { CloseHandle(job); return fail(L"cannot start the owned BMN runtime", launchError); }
#ifdef BMN_CLI_OWNERSHIP_TEST
  if (!testCreationGate(L"created", child.dwProcessId)) {
    endRuntimeTree(job, 1); CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
    return fail(L"creation test boundary was not observed", GetLastError());
  }
#endif
  if (ResumeThread(child.hThread) == (DWORD)-1) {
    DWORD error = GetLastError(); endRuntimeTree(job, 1);
    CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
    return fail(L"cannot resume the BMN runtime", error);
  }
#ifdef BMN_CLI_OWNERSHIP_TEST
  if (!testCreationGate(L"resumed", child.dwProcessId)) {
    endRuntimeTree(job, 1); CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job);
    return fail(L"resume test boundary was not observed", GetLastError());
  }
#endif
  CloseHandle(child.hThread);
  DWORD waited = WaitForSingleObject(child.hProcess, INFINITE);
  DWORD exitCode = 1;
  BOOL exited = waited == WAIT_OBJECT_0 && GetExitCodeProcess(child.hProcess, &exitCode);
  DWORD waitError = GetLastError();
  BOOL ended = endRuntimeTree(job, exitCode);
  DWORD cleanupError = GetLastError();
  CloseHandle(child.hProcess); CloseHandle(job);
  free(commandLine);
  if (!exited) return fail(L"cannot confirm runtime exit", waitError);
  if (!ended) return fail(L"cannot confirm runtime tree cleanup", cleanupError);
  return (int)exitCode;
#endif
}
