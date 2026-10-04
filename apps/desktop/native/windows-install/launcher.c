// Stable GUI launcher. The pinned offline worker selects a versioned payload.
// Atomic job assignment owns the worker, GUI, utility and their descendants.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <stdlib.h>
#include <wchar.h>

#define PATH_CAPACITY 32768
static int failure(DWORD error) {
  wchar_t message[160];
  swprintf(message, 160, L"BMN could not start (Windows error %lu). Rerun its installer or inspect the retained installation state.", (unsigned long)error);
  MessageBoxW(NULL, message, L"BMN", MB_OK | MB_ICONERROR);
  return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR tail, int show) {
  (void)instance; (void)previous; (void)show;
  wchar_t root[PATH_CAPACITY], runtime[PATH_CAPACITY], worker[PATH_CAPACITY];
  DWORD length = GetModuleFileNameW(NULL, root, PATH_CAPACITY);
  if (!length || length >= PATH_CAPACITY) return failure(ERROR_FILENAME_EXCED_RANGE);
  wchar_t* slash = wcsrchr(root, L'\\');
  if (!slash) return failure(ERROR_BAD_PATHNAME);
  *slash = 0;
  // The same owned launcher runs the initial installer worker from its embedded
  // payload before a stable bootstrap exists. No worker bypasses job ownership.
#ifdef BMN_INSTALLER_RUNNER
  if (swprintf(runtime, PATH_CAPACITY, L"%ls\\..\\..\\BMN-worker.exe", root) < 0 ||
      swprintf(worker, PATH_CAPACITY, L"%ls\\worker.cjs", root) < 0) return failure(ERROR_FILENAME_EXCED_RANGE);
#else
  if (swprintf(runtime, PATH_CAPACITY, L"%ls\\bootstrap\\BMN-worker.exe", root) < 0 ||
      swprintf(worker, PATH_CAPACITY, L"%ls\\bootstrap\\resources\\install\\worker.cjs", root) < 0) return failure(ERROR_FILENAME_EXCED_RANGE);
#endif
  size_t capacity = wcslen(runtime) + wcslen(worker) + wcslen(tail) + 8;
  if (capacity > PATH_CAPACITY) return failure(ERROR_FILENAME_EXCED_RANGE);
  wchar_t* command = (wchar_t*)calloc(capacity, sizeof(wchar_t));
  if (!command) return failure(ERROR_OUTOFMEMORY);
  swprintf(command, capacity, L"\"%ls\" \"%ls\" %ls", runtime, worker, tail);
  if (!SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1") ||
      !SetEnvironmentVariableW(L"NODE_OPTIONS", NULL) || !SetEnvironmentVariableW(L"NODE_PATH", NULL)) {
    DWORD error = GetLastError(); free(command); return failure(error);
  }
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) { DWORD error = GetLastError(); free(command); return failure(error); }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetHandleInformation(job, HANDLE_FLAG_INHERIT, 0) ||
      !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    DWORD error = GetLastError(); CloseHandle(job); free(command); return failure(error);
  }
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!attributes) { CloseHandle(job); free(command); return failure(ERROR_OUTOFMEMORY); }
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &bytes)) {
    DWORD error = GetLastError(); HeapFree(GetProcessHeap(), 0, attributes); CloseHandle(job); free(command); return failure(error);
  }
  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup)); startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
  // A GUI launcher has no console. Give Node valid standard handles, with an
  // explicit allowlist rather than inheriting any unrelated parent handles.
  SECURITY_ATTRIBUTES security = { sizeof(security), NULL, TRUE };
  HANDLE nullStream = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
    &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (nullStream == INVALID_HANDLE_VALUE) {
    DWORD streamError = GetLastError(); DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(job); free(command); return failure(streamError);
  }
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = nullStream; startup.StartupInfo.hStdOutput = nullStream; startup.StartupInfo.hStdError = nullStream;
  PROCESS_INFORMATION child;
  ZeroMemory(&child, sizeof(child));
  BOOL configured = UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL) &&
    UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &nullStream, sizeof(nullStream), NULL, NULL);
  BOOL created = configured && CreateProcessW(runtime, command, NULL, NULL, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, NULL, root, &startup.StartupInfo, &child);
  DWORD error = GetLastError();
  CloseHandle(nullStream);
  DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes); free(command);
  if (!created) { CloseHandle(job); return failure(error); }
  CloseHandle(child.hThread);
  DWORD code = 1;
  BOOL exited = WaitForSingleObject(child.hProcess, INFINITE) == WAIT_OBJECT_0 && GetExitCodeProcess(child.hProcess, &code);
  error = GetLastError();
  // Worker exit never leaves a GUI or local launch tree behind.
  BOOL ended = TerminateJobObject(job, code);
  if (ended) {
    ULONGLONG deadline = GetTickCount64() + 5000;
    for (;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) { ended = FALSE; break; }
      if (accounting.ActiveProcesses == 0) break;
      if (GetTickCount64() >= deadline) { SetLastError(ERROR_TIMEOUT); ended = FALSE; break; }
      Sleep(10);
    }
  }
  DWORD cleanupError = GetLastError();
  CloseHandle(child.hProcess); CloseHandle(job);
  if (!exited) return failure(error);
  if (!ended) return failure(cleanupError);
  return code == 0 ? 0 : failure(ERROR_PROCESS_ABORTED);
}
